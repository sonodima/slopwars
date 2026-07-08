// ─── Editor host: the Vite plugin that unifies everything ────────────────────
// This turns the editor's Vite dev server into the self-contained editor host,
// all in one process (`pnpm dev:editor`):
//
//   • /__editor/*        file API the browser UI calls (catalog, maps, save, import)
//   • /__editor/bridge/* long-poll queue: host → open editor page (live ops)
//   • /mcp               the MCP server (Streamable HTTP) that AI tools connect to
//
// It is an editor-only plugin (the game never loads it), so no MCP/host code
// leaks into the game build. The shared asset-catalog plugin still provides the
// virtual modules and serves maps/*.json; this one adds the writable +
// agent-facing surface. There is no separate MCP process — clients point straight
// at http://localhost:5173/mcp.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge";
import { createMcp } from "./mcp";
import { createMaterial, deleteMaterial, importAsset, loadMap, renameMaterial, saveMap, saveMaterial, scanAssets, scanMaps } from "./files";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
function json(res: ServerResponse, code: number, data: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

interface Options {
  /** repo root that contains `public/` and `maps/` (defaults to the app's ../..) */
  root?: string;
}

export function editorHostPlugin(opts: Options = {}): Plugin {
  const appDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(opts.root ?? path.resolve(appDir, "../../.."));

  const bridge = new Bridge();
  const mcp = createMcp({ root, bridge });
  const sessionId = randomUUID(); // handed out on initialize; we're otherwise stateless

  return {
    name: "slopwars-editor-host",
    apply: "serve", // dev only; a production `vite build` needs none of this

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        const method = req.method ?? "GET";

        // ── MCP server: Streamable HTTP transport ──
        if (url === "/mcp") return handleMcp(req, res, method, mcp, sessionId);

        if (!url.startsWith("/__editor/")) return next();

        // ── read-only file API (also used by the browser UI) ──
        if (method === "GET" && url === "/__editor/catalog") return json(res, 200, scanAssets(root));
        if (method === "GET" && url === "/__editor/maps") return json(res, 200, scanMaps(root));

        // ── map save (writes the browser's current map into the repo) ──
        if (method === "POST" && url === "/__editor/save") {
          readBody(req).then((body) => {
            const { id, def } = JSON.parse(body);
            json(res, 200, saveMap(root, id, def));
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        // ── materials: create / save / rename / delete (browser UI) ──
        if (method === "POST" && url === "/__editor/material") {
          readBody(req).then((body) => {
            const b = JSON.parse(body);
            const r = b.op === "create" ? createMaterial(root, b.type)
              : b.op === "rename" ? renameMaterial(root, b.from, b.to)
              : b.op === "delete" ? deleteMaterial(root, b.name)
              : saveMaterial(root, b.name, b.def);
            json(res, (r as { error?: string }).error ? 400 : 200, r);
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        // ── asset import (browser UI); MCP import tools call importAsset directly ──
        if (method === "POST" && url === "/__editor/import") {
          readBody(req).then((body) => {
            const result = importAsset(root, JSON.parse(body));
            json(res, result.error ? 400 : 200, result);
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        // ── bridge: the open editor page long-polls for live commands ──
        if (method === "GET" && url === "/__editor/bridge/poll") return json(res, 200, bridge.poll());
        if (method === "POST" && url === "/__editor/bridge/result") {
          readBody(req).then((body) => {
            const { id, result } = JSON.parse(body);
            if (id) bridge.result(id, result);
            json(res, 200, { ok: true });
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        return next();
      });

      const scheme = `http://localhost:${server.config.server.port ?? 5173}`;
      server.config.logger.info(`  ➜  MCP:     ${scheme}/mcp`);
    },
  };
}

/** Minimal MCP Streamable HTTP transport: POST a JSON-RPC message (or batch) and
 *  get the response as application/json (the spec permits this in place of SSE);
 *  notifications get 202; there is no server-initiated stream, so GET is 405. */
function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  mcp: { handle: (msg: any) => Promise<any> },
  sessionId: string,
): void {
  if (method === "GET") { res.statusCode = 405; res.setHeader("Allow", "POST, DELETE"); res.end(); return; }
  if (method === "DELETE") { res.statusCode = 200; res.end(); return; } // session end — nothing to clean up
  if (method !== "POST") { res.statusCode = 405; res.setHeader("Allow", "POST, DELETE"); res.end(); return; }

  readBody(req).then(async (body) => {
    let msg: any;
    try { msg = JSON.parse(body || "{}"); }
    catch { return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }

    const isInit = (m: any) => m?.method === "initialize";
    const headers = (Array.isArray(msg) ? msg.some(isInit) : isInit(msg)) ? { "Mcp-Session-Id": sessionId } : {};

    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => mcp.handle(m)))).filter((r) => r !== null);
      if (!out.length) { res.statusCode = 202; res.end(); return; }
      return json(res, 200, out, headers);
    }

    const response = await mcp.handle(msg);
    if (response === null) { res.statusCode = 202; res.end(); return; } // notification
    return json(res, 200, response, headers);
  }).catch((e) => json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e) } }));
}

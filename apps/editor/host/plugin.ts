// ─── Editor host: the Vite plugin that unifies everything ────────────────────
// This turns the editor's Vite dev server into the self-contained editor host,
// all in one process (`pnpm editor`):
//
//   • /__editor/*        file API the browser UI calls (catalog, maps, save, import)
//   • /__editor/bridge/* long-poll queue: host → open editor page (live ops)
//   • /mcp               the MCP server (Streamable HTTP) that AI tools connect to
//
// It is an editor-only plugin (the game never loads it), so no MCP/host code
// leaks into the game build. The shared asset-catalog plugin still provides the
// virtual modules and serves maps/*.json; this one adds the writable +
// agent-facing surface. There is no separate MCP process — clients point straight
// at http://localhost:5210/mcp.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge";
import { createMcp } from "./mcp";
import { V_ASSETS, V_MAPS } from "../../../packages/shared/src/vite-asset-catalog";
import { createMaterial, createTexture, deleteAssetFile, deleteMap, deleteMaterial, deleteModel, deleteTexture, deleteTextureMap, importAsset, loadMap, renameMaterial, renameTexture, saveMap, saveMaterial, saveModelMeta, scanAssets, scanMaps } from "./files";
import type { PhType } from "./polyhaven";
import { storeImport, storeList } from "./store";

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

// Content type by extension for the static /assets serving below. Only the asset
// kinds the editor/game actually fetch; anything else falls back to octet-stream.
const MIME: Record<string, string> = {
  ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".bin": "application/octet-stream",
  ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".ktx2": "image/ktx2", ".hdr": "image/vnd.radiance",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".txt": "text/plain; charset=utf-8",
};

// Serve one public/assets file straight from disk. Vite's own publicDir middleware
// gates on a `publicFiles` set that is seeded at startup and only kept current by the
// file watcher — but the editor IGNORES the public/assets watcher (an asset write must
// not full-reload the page and drop open documents), so a just-imported file is never
// added to that set and Vite answers its URL with the SPA index.html instead. That HTML
// then fails to parse as glTF/JSON and the model/texture loads as nothing (transparent,
// no thumbnail). Reading from disk here sidesteps the stale set entirely. Returns false
// (→ fall through to Vite) when the path escapes the root or names no real file.
function serveAsset(root: string, url: string, res: ServerResponse, headOnly: boolean): boolean {
  const rel = decodeURIComponent(url.replace(/^\/+/, ""));            // "assets/models/x/x.gltf"
  const abs = path.resolve(root, "public", rel);
  const base = path.resolve(root, "public/assets");
  if (abs !== base && !abs.startsWith(base + path.sep)) return false;  // traversal guard
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch { return false; }
  if (!stat.isFile()) return false;
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "no-cache");   // assets change under the editor; never stale-serve
  if (headOnly) { res.end(); return true; }
  fs.createReadStream(abs).pipe(res);
  return true;
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

        // ── static public/assets, served from disk (Vite skips post-start imports) ──
        if ((method === "GET" || method === "HEAD") && url.startsWith("/assets/")) {
          if (serveAsset(root, url, res, method === "HEAD")) return;
        }

        if (!url.startsWith("/__editor/")) return next();

        // Every editor POST below mutates the asset tree (bridge traffic aside).
        // The editor's vite config ignores the public/assets watcher (an asset
        // write must NOT full-reload the page and drop the open documents), which
        // also silences the shared plugin's watcher-driven virtual-module
        // invalidation — so do it here instead, once the write has finished: the
        // open page refreshes itself through /__editor/catalog, and the next
        // manual page load re-scans instead of serving the dev-server-start
        // snapshot (models used to render as nothing until a server restart).
        if (method === "POST" && !url.startsWith("/__editor/bridge/")) {
          res.on("finish", () => {
            for (const v of [V_ASSETS, V_MAPS]) {
              const mod = server.moduleGraph.getModuleById("\0" + v);
              if (mod) server.moduleGraph.invalidateModule(mod);
            }
          });
        }

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

        // ── models: save calibration meta / delete (browser UI) ──
        if (method === "POST" && url === "/__editor/model") {
          readBody(req).then((body) => {
            const b = JSON.parse(body);
            const r = b.op === "delete" ? deleteModel(root, b.name) : saveModelMeta(root, b.name, b.meta ?? {});
            json(res, (r as { error?: string }).error ? 400 : 200, r);
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        // ── textures: delete whole set / clear one PBR map (browser UI + editor tab) ──
        if (method === "POST" && url === "/__editor/texture") {
          readBody(req).then((body) => {
            const b = JSON.parse(body);
            const r = b.op === "create" ? createTexture(root, b.name)
              : b.op === "rename" ? renameTexture(root, b.from, b.to)
              : b.op === "clearMap" ? deleteTextureMap(root, b.name, b.slot)
              : deleteTexture(root, b.name);
            json(res, (r as { error?: string }).error ? 400 : 200, r);
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        // ── generic asset-file delete: hdri / audio (browser UI right-click) ──
        if (method === "POST" && url === "/__editor/asset") {
          readBody(req).then((body) => {
            const b = JSON.parse(body);
            const r = deleteAssetFile(root, b.file);
            json(res, (r as { error?: string }).error ? 400 : 200, r);
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        // ── maps: delete (browser UI right-click) ──
        if (method === "POST" && url === "/__editor/map") {
          readBody(req).then((body) => {
            const b = JSON.parse(body);
            const r = b.op === "delete" ? deleteMap(root, b.file) : { error: "unknown op" };
            json(res, (r as { error?: string }).error ? 400 : 200, r);
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        // ── asset store: merged multi-source listing / variant import (store.ts) ──
        if (method === "GET" && url === "/__editor/store/list") {
          const type = new URL(req.url ?? "", "http://localhost").searchParams.get("type") as PhType | null;
          storeList(type ?? "models")
            .then((assets) => json(res, 200, assets))
            .catch((e) => json(res, 500, { error: String(e) }));
          return;
        }
        if (method === "POST" && url === "/__editor/store/import") {
          readBody(req).then(async (body) => {
            const r = await storeImport(root, JSON.parse(body));
            json(res, r.error ? 400 : 200, r);
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

      const scheme = `http://localhost:${server.config.server.port ?? 5210}`;
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

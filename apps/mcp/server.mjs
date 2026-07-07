#!/usr/bin/env node
// ─── SlopWars editor MCP server ──────────────────────────────────────────────
// A dependency-free Model Context Protocol server (JSON-RPC 2.0 over stdio) that
// lets AI tools drive the SlopWars map editor: list/add/move/rotate/scale/delete
// objects, edit params, import textures/models/audio/HDRIs, move + rotate the
// viewport camera, and take screenshots. It forwards each tool call to the editor
// dev server's MCP bridge (/__editor/mcp/cmd), which the running editor page
// executes live. Start the editor first (`pnpm dev:editor`), then point your tool
// at:  node apps/mcp/server.mjs   (env SLOPWARS_EDITOR_URL, default :5173)
import { readFile } from "node:fs/promises";
import path from "node:path";

const EDITOR_URL = (process.env.SLOPWARS_EDITOR_URL || "http://localhost:5173").replace(/\/$/, "");
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

// ── talk to the editor bridge ────────────────────────────────────────────────
async function callEditor(op, extra = {}) {
  let res;
  try {
    res = await fetch(`${EDITOR_URL}/__editor/mcp/cmd`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...extra }),
    });
  } catch (e) {
    throw new Error(`cannot reach the editor at ${EDITOR_URL} (run \`pnpm dev:editor\`): ${e}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `editor error ${res.status}`);
  const result = body.result;
  if (result && result.error) throw new Error(result.error);
  return result;
}

/** read local files → import file payloads ({name, data, slot?}) */
async function filepayload(p, slot) {
  const data = (await readFile(p)).toString("base64");
  return { name: path.basename(p), data, ...(slot ? { slot } : {}) };
}

// ── tool definitions ─────────────────────────────────────────────────────────
const V3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const tools = [
  { name: "editor_get_state", description: "Get editor status: current map, object count, camera pose.", inputSchema: { type: "object", properties: {} },
    run: () => callEditor("getState") },
  { name: "editor_list_objects", description: "List every placed object with its index, type, name and transform.", inputSchema: { type: "object", properties: {} },
    run: () => callEditor("listObjects") },
  { name: "editor_get_object", description: "Get one object by index.", inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
    run: (a) => callEditor("getObject", { index: a.index }) },
  { name: "editor_list_object_types", description: "List placeable object types with their categories and default params.", inputSchema: { type: "object", properties: {} },
    run: () => callEditor("listObjectTypes") },
  { name: "editor_list_assets", description: "List available models, textures, audio clips, HDRIs and object types.", inputSchema: { type: "object", properties: {} },
    run: () => callEditor("listAssets") },
  { name: "editor_get_map", description: "Return the full current MapDef (meta, env, objects, groups).", inputSchema: { type: "object", properties: {} },
    run: () => callEditor("getMap") },

  { name: "editor_add_object", description: "Place a new object. `type` must be a known object type (see editor_list_object_types). `at` is [x,y,z].",
    inputSchema: { type: "object", properties: { type: { type: "string" }, at: V3, rot: V3, scale: V3, name: { type: "string" }, params: { type: "object" } }, required: ["type", "at"] },
    run: (a) => callEditor("addObject", { object: { type: a.type, at: a.at, ...(a.rot ? { rot: a.rot } : {}), ...(a.scale ? { scale: a.scale } : {}), ...(a.name ? { name: a.name } : {}), ...(a.params ? { params: a.params } : {}) } }) },
  { name: "editor_place_model", description: "Convenience: place a model as a prop at [x,y,z].",
    inputSchema: { type: "object", properties: { model: { type: "string" }, at: V3, rot: V3, scale: V3 }, required: ["model", "at"] },
    run: (a) => callEditor("addObject", { object: { type: "prop", at: a.at, ...(a.rot ? { rot: a.rot } : {}), ...(a.scale ? { scale: a.scale } : {}), params: { model: a.model } } }) },
  { name: "editor_place_sound", description: "Convenience: place a positional sound (audio clip) at [x,y,z].",
    inputSchema: { type: "object", properties: { clip: { type: "string" }, at: V3 }, required: ["clip", "at"] },
    run: (a) => callEditor("addObject", { object: { type: "sound", at: a.at, params: { clip: a.clip } } }) },
  { name: "editor_update_object", description: "Edit an object's transform / name / group / params (merged) by index.",
    inputSchema: { type: "object", properties: { index: { type: "number" }, at: V3, rot: V3, scale: V3, name: { type: "string" }, group: { type: "string" }, params: { type: "object" } }, required: ["index"] },
    run: (a) => callEditor("updateObject", { index: a.index, patch: { ...(a.at ? { at: a.at } : {}), ...(a.rot ? { rot: a.rot } : {}), ...(a.scale ? { scale: a.scale } : {}), ...(a.name !== undefined ? { name: a.name } : {}), ...(a.group !== undefined ? { group: a.group } : {}), ...(a.params ? { params: a.params } : {}) } }) },
  { name: "editor_move_object", description: "Move an object to a new [x,y,z].",
    inputSchema: { type: "object", properties: { index: { type: "number" }, at: V3 }, required: ["index", "at"] },
    run: (a) => callEditor("updateObject", { index: a.index, patch: { at: a.at } }) },
  { name: "editor_delete_object", description: "Delete an object by index.",
    inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
    run: (a) => callEditor("deleteObject", { index: a.index }) },
  { name: "editor_duplicate_object", description: "Duplicate an object by index.",
    inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
    run: (a) => callEditor("duplicateObject", { index: a.index }) },
  { name: "editor_select_object", description: "Select an object by index (frames it in the viewport).",
    inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
    run: (a) => callEditor("selectObject", { index: a.index }) },

  { name: "editor_import_texture", description: "Import a PBR texture set from local files into public/assets/textures/<name>/.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, color: { type: "string", description: "path to color/albedo map" }, normal: { type: "string" }, arm: { type: "string", description: "path to packed AO/rough/metal map" } }, required: ["name", "color"] },
    run: async (a) => {
      const files = [await filepayloadSafe(a.color, "color")];
      if (a.normal) files.push(await filepayloadSafe(a.normal, "normal"));
      if (a.arm) files.push(await filepayloadSafe(a.arm, "arm"));
      return callEditor("import", { req: { kind: "texture", name: a.name, files } });
    } },
  { name: "editor_import_model", description: "Import a glTF model (a .glb, or a .gltf plus its .bin/textures) into public/assets/models/<name>/.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, files: { type: "array", items: { type: "string" }, description: "local file paths" } }, required: ["name", "files"] },
    run: async (a) => callEditor("import", { req: { kind: "model", name: a.name, files: await Promise.all(a.files.map((p) => filepayloadSafe(p))) } }) },
  { name: "editor_import_audio", description: "Import an audio clip into public/assets/audio/.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["file"] },
    run: async (a) => callEditor("import", { req: { kind: "audio", name: a.name || "", files: [await filepayloadSafe(a.file)] } }) },
  { name: "editor_import_hdri", description: "Import an HDRI (.hdr) into public/assets/hdri/.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["file"] },
    run: async (a) => callEditor("import", { req: { kind: "hdri", name: a.name || "", files: [await filepayloadSafe(a.file)] } }) },

  { name: "editor_camera_focus", description: "Point the viewport camera at a world position [x,y,z].",
    inputSchema: { type: "object", properties: { at: V3, dist: { type: "number" } }, required: ["at"] },
    run: (a) => callEditor("cameraFocus", { at: a.at, dist: a.dist }) },
  { name: "editor_camera_set", description: "Set the camera pose absolutely: position [x,y,z] and/or yaw+pitch (radians).",
    inputSchema: { type: "object", properties: { pos: V3, yaw: { type: "number" }, pitch: { type: "number" } } },
    run: (a) => callEditor("cameraSet", { pos: a.pos, yaw: a.yaw, pitch: a.pitch }) },
  { name: "editor_camera_move", description: "Rotate the viewport camera by yaw/pitch deltas (radians) and/or dolly forward.",
    inputSchema: { type: "object", properties: { dYaw: { type: "number" }, dPitch: { type: "number" }, dolly: { type: "number" } } },
    run: (a) => callEditor("cameraMove", { dYaw: a.dYaw, dPitch: a.dPitch, dolly: a.dolly }) },
  { name: "editor_screenshot", description: "Capture a PNG screenshot of the current viewport.", inputSchema: { type: "object", properties: {} },
    run: async () => { const r = await callEditor("screenshot"); return { __image: r.dataUrl }; } },

  { name: "editor_save_map", description: "Save the current map to maps/<id>.json.", inputSchema: { type: "object", properties: {} },
    run: () => callEditor("saveMap") },
  { name: "editor_load_map", description: "Load a map by file path (e.g. maps/koi.json).",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    run: (a) => callEditor("loadMap", { file: a.file }) },
  { name: "editor_new_map", description: "Start a new blank map.", inputSchema: { type: "object", properties: {} },
    run: () => callEditor("newMap") },
];

async function filepayloadSafe(p, slot) {
  try { return await filepayload(p, slot); }
  catch (e) { throw new Error(`cannot read file ${p}: ${e}`); }
}

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ── JSON-RPC / MCP plumbing (newline-delimited over stdio) ──────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "slopwars-editor", version: "1.0.0" } });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // no response
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const tool = toolByName.get(params?.name);
    if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.run(params.arguments || {});
      if (out && out.__image && typeof out.__image === "string") {
        const b64 = out.__image.replace(/^data:image\/png;base64,/, "");
        return reply(id, { content: [{ type: "image", data: b64, mimeType: "image/png" }] });
      }
      return reply(id, { content: [{ type: "text", text: JSON.stringify(out ?? { ok: true }, null, 2) }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true });
    }
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

// stdin line reader (messages are newline-delimited JSON)
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("bad JSON:", line); continue; }
    Promise.resolve(handle(msg)).catch((e) => log("handler error:", e));
  }
});
process.stdin.on("end", () => process.exit(0));
log(`slopwars-editor MCP server ready (editor: ${EDITOR_URL})`);

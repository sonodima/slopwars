// ─── Editor host: the MCP server (unified with the editor) ───────────────────
// The MCP server now lives *inside* the editor host (the Vite dev server), not in
// a separate process. Tool logic is split by what it actually needs:
//
//   • file tools (import texture/model/audio/hdri) run server-side against the
//     repo working tree — they work with NO editor window open.
//   • live tools (map/object/camera/screenshot/save/load) forward to the open
//     editor page via the bridge, since that state lives in the browser.
//
// `apps/mcp/server.mjs` is now just a thin stdio↔HTTP pipe to `handle()` here, so
// there's a single source of truth for the tools. `handle()` processes one
// JSON-RPC message and returns the response object (or null for notifications).
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Bridge } from "./bridge";
import { importAsset, type ImportFile } from "./files";

interface Deps {
  root: string;
  bridge: Bridge;
}

type Args = Record<string, any>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (a: Args) => Promise<unknown>;
}

const V3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };

/** read a local file into an import payload ({name, data, slot?}) */
async function filepayload(p: string, slot?: ImportFile["slot"]): Promise<ImportFile> {
  try {
    const data = (await readFile(p)).toString("base64");
    return { name: path.basename(p), data, ...(slot ? { slot } : {}) };
  } catch (e) {
    throw new Error(`cannot read file ${p}: ${e}`);
  }
}

export function createMcp({ root, bridge }: Deps): { handle: (msg: any) => Promise<any> } {
  // live ops → the open editor page
  const live = (op: string, extra: Record<string, unknown> = {}) => bridge.exec(op, extra);

  // file ops → server-side; then nudge any open page to refresh its browser
  const doImport = async (req: Parameters<typeof importAsset>[1]): Promise<unknown> => {
    const result = importAsset(root, req);
    if (result.error) throw new Error(result.error);
    bridge.notify("reloadCatalog");
    return result;
  };

  const tools: Tool[] = [
    { name: "editor_get_state", description: "Get editor status: current map, object count, camera pose.", inputSchema: { type: "object", properties: {} },
      run: () => live("getState") },
    { name: "editor_list_objects", description: "List every placed object with its index, type, name and transform.", inputSchema: { type: "object", properties: {} },
      run: () => live("listObjects") },
    { name: "editor_get_object", description: "Get one object by index.", inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
      run: (a) => live("getObject", { index: a.index }) },
    { name: "editor_list_object_types", description: "List placeable object types with their categories and default params.", inputSchema: { type: "object", properties: {} },
      run: () => live("listObjectTypes") },
    { name: "editor_list_assets", description: "List available models, textures, audio clips, HDRIs and object types.", inputSchema: { type: "object", properties: {} },
      run: () => live("listAssets") },
    { name: "editor_get_map", description: "Return the full current MapDef (meta, env, objects, groups).", inputSchema: { type: "object", properties: {} },
      run: () => live("getMap") },

    { name: "editor_add_object", description: "Place a new object. `type` must be a known object type (see editor_list_object_types). `at` is [x,y,z].",
      inputSchema: { type: "object", properties: { type: { type: "string" }, at: V3, rot: V3, scale: V3, name: { type: "string" }, params: { type: "object" } }, required: ["type", "at"] },
      run: (a) => live("addObject", { object: { type: a.type, at: a.at, ...(a.rot ? { rot: a.rot } : {}), ...(a.scale ? { scale: a.scale } : {}), ...(a.name ? { name: a.name } : {}), ...(a.params ? { params: a.params } : {}) } }) },
    { name: "editor_place_model", description: "Convenience: place a model as a prop at [x,y,z].",
      inputSchema: { type: "object", properties: { model: { type: "string" }, at: V3, rot: V3, scale: V3 }, required: ["model", "at"] },
      run: (a) => live("addObject", { object: { type: "prop", at: a.at, ...(a.rot ? { rot: a.rot } : {}), ...(a.scale ? { scale: a.scale } : {}), params: { model: a.model } } }) },
    { name: "editor_place_sound", description: "Convenience: place a positional sound (audio clip) at [x,y,z].",
      inputSchema: { type: "object", properties: { clip: { type: "string" }, at: V3 }, required: ["clip", "at"] },
      run: (a) => live("addObject", { object: { type: "sound", at: a.at, params: { clip: a.clip } } }) },
    { name: "editor_update_object", description: "Edit an object's transform / name / group / params (merged) by index.",
      inputSchema: { type: "object", properties: { index: { type: "number" }, at: V3, rot: V3, scale: V3, name: { type: "string" }, group: { type: "string" }, params: { type: "object" } }, required: ["index"] },
      run: (a) => live("updateObject", { index: a.index, patch: { ...(a.at ? { at: a.at } : {}), ...(a.rot ? { rot: a.rot } : {}), ...(a.scale ? { scale: a.scale } : {}), ...(a.name !== undefined ? { name: a.name } : {}), ...(a.group !== undefined ? { group: a.group } : {}), ...(a.params ? { params: a.params } : {}) } }) },
    { name: "editor_move_object", description: "Move an object to a new [x,y,z].",
      inputSchema: { type: "object", properties: { index: { type: "number" }, at: V3 }, required: ["index", "at"] },
      run: (a) => live("updateObject", { index: a.index, patch: { at: a.at } }) },
    { name: "editor_delete_object", description: "Delete an object by index.",
      inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
      run: (a) => live("deleteObject", { index: a.index }) },
    { name: "editor_duplicate_object", description: "Duplicate an object by index.",
      inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
      run: (a) => live("duplicateObject", { index: a.index }) },
    { name: "editor_select_object", description: "Select an object by index (frames it in the viewport).",
      inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
      run: (a) => live("selectObject", { index: a.index }) },

    { name: "editor_import_texture", description: "Import a PBR texture set from local files into public/assets/textures/<name>/.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, color: { type: "string", description: "path to color/albedo map" }, normal: { type: "string" }, arm: { type: "string", description: "path to packed AO/rough/metal map" } }, required: ["name", "color"] },
      run: async (a) => {
        const files = [await filepayload(a.color, "color")];
        if (a.normal) files.push(await filepayload(a.normal, "normal"));
        if (a.arm) files.push(await filepayload(a.arm, "arm"));
        return doImport({ kind: "texture", name: a.name, files });
      } },
    { name: "editor_import_model", description: "Import a glTF model (a .glb, or a .gltf plus its .bin/textures) into public/assets/models/<name>/.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, files: { type: "array", items: { type: "string" }, description: "local file paths" } }, required: ["name", "files"] },
      run: async (a) => doImport({ kind: "model", name: a.name, files: await Promise.all((a.files as string[]).map((p) => filepayload(p))) }) },
    { name: "editor_import_audio", description: "Import an audio clip into public/assets/audio/.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["file"] },
      run: async (a) => doImport({ kind: "audio", name: a.name || "", files: [await filepayload(a.file)] }) },
    { name: "editor_import_hdri", description: "Import an HDRI (.hdr) into public/assets/hdri/.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["file"] },
      run: async (a) => doImport({ kind: "hdri", name: a.name || "", files: [await filepayload(a.file)] }) },

    { name: "editor_camera_focus", description: "Point the viewport camera at a world position [x,y,z].",
      inputSchema: { type: "object", properties: { at: V3, dist: { type: "number" } }, required: ["at"] },
      run: (a) => live("cameraFocus", { at: a.at, dist: a.dist }) },
    { name: "editor_camera_set", description: "Set the camera pose absolutely: position [x,y,z] and/or yaw+pitch (radians).",
      inputSchema: { type: "object", properties: { pos: V3, yaw: { type: "number" }, pitch: { type: "number" } } },
      run: (a) => live("cameraSet", { pos: a.pos, yaw: a.yaw, pitch: a.pitch }) },
    { name: "editor_camera_move", description: "Rotate the viewport camera by yaw/pitch deltas (radians) and/or dolly forward.",
      inputSchema: { type: "object", properties: { dYaw: { type: "number" }, dPitch: { type: "number" }, dolly: { type: "number" } } },
      run: (a) => live("cameraMove", { dYaw: a.dYaw, dPitch: a.dPitch, dolly: a.dolly }) },
    { name: "editor_screenshot", description: "Capture a PNG screenshot of the current viewport.", inputSchema: { type: "object", properties: {} },
      run: async () => { const r = await live("screenshot") as { dataUrl: string }; return { __image: r.dataUrl }; } },

    { name: "editor_save_map", description: "Save the current map to maps/<id>.json.", inputSchema: { type: "object", properties: {} },
      run: () => live("saveMap") },
    { name: "editor_load_map", description: "Load a map by file path (e.g. maps/koi.json).",
      inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
      run: (a) => live("loadMap", { file: a.file }) },
    { name: "editor_new_map", description: "Start a new blank map.", inputSchema: { type: "object", properties: {} },
      run: () => live("newMap") },
  ];

  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const ok = (id: any, result: any) => ({ jsonrpc: "2.0", id, result });
  const fail = (id: any, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(msg: any): Promise<any> {
    const { id, method, params } = msg ?? {};
    if (method === "initialize") {
      const protocolVersion = params?.protocolVersion || "2025-06-18";
      return ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slopwars-editor", version: "1.0.0" } });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null; // no response
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") {
      return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === "tools/call") {
      const tool = toolByName.get(params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const out = await tool.run(params.arguments || {}) as any;
        if (out && out.__image && typeof out.__image === "string") {
          const b64 = out.__image.replace(/^data:image\/png;base64,/, "");
          return ok(id, { content: [{ type: "image", data: b64, mimeType: "image/png" }] });
        }
        return ok(id, { content: [{ type: "text", text: JSON.stringify(out ?? { ok: true }, null, 2) }] });
      } catch (e: any) {
        return ok(id, { content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true });
      }
    }
    if (id !== undefined) return fail(id, -32601, `method not found: ${method}`);
    return null;
  }

  return { handle };
}

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
import {
  createMaterial, deleteMaterial, deleteModel, deleteTexture, importAsset,
  renameMaterial, saveMaterial, saveModelMeta, scanAssets, type ImportFile,
} from "./files";
import type { MaterialDef } from "../../../packages/shared/src/materials";
import type { CollisionBox, ModelMeta } from "../../../packages/shared/src/catalog";

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

    // ── groups (a first-class parent with its own transform; can be a physics body) ──
    { name: "editor_list_groups", description: "List all groups (id, name, parent, transform, physics/mass).", inputSchema: { type: "object", properties: {} },
      run: () => live("listGroups") },
    { name: "editor_get_group", description: "Get one group by id, with its world transform and member object indices.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (a) => live("getGroup", { id: a.id }) },
    { name: "editor_create_group", description: "Group objects into a new group. Pass `objects` (an array of object indices) or omit to group the current selection. Returns the new group id.",
      inputSchema: { type: "object", properties: { objects: { type: "array", items: { type: "number" } }, name: { type: "string" } } },
      run: (a) => live("createGroup", { objects: a.objects, name: a.name }) },
    { name: "editor_update_group", description: "Edit a group: name, parent (id or null for top level), world transform (at/rot/scale), or physics. Set `physics:true` (+ optional `mass` kg) to simulate the whole group as one movable rigid body.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, parent: { type: "string" }, at: V3, rot: V3, scale: V3, physics: { type: "boolean" }, mass: { type: "number" } }, required: ["id"] },
      run: (a) => live("updateGroup", { id: a.id, patch: { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.parent !== undefined ? { parent: a.parent } : {}), ...(a.at ? { at: a.at } : {}), ...(a.rot ? { rot: a.rot } : {}), ...(a.scale ? { scale: a.scale } : {}), ...(a.physics !== undefined ? { physics: a.physics } : {}), ...(a.mass !== undefined ? { mass: a.mass } : {}) } }) },
    { name: "editor_delete_group", description: "Delete a group AND every object inside it (recursively).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (a) => live("deleteGroup", { id: a.id }) },
    { name: "editor_ungroup", description: "Dissolve a group, keeping its objects (they move up to the parent, world transforms preserved).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (a) => live("ungroup", { id: a.id }) },
    { name: "editor_set_object_group", description: "Move an object (by index) into a group (or to top level with null/empty group), preserving its world transform.",
      inputSchema: { type: "object", properties: { index: { type: "number" }, group: { type: "string" } }, required: ["index"] },
      run: (a) => live("setObjectGroup", { index: a.index, group: a.group ?? "" }) },

    { name: "editor_import_texture", description: "Import a PBR texture set from local files into public/assets/textures/<name>/.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, color: { type: "string", description: "path to color/albedo map" }, normal: { type: "string" }, arm: { type: "string", description: "path to packed AO/rough/metal map" } }, required: ["name", "color"] },
      run: async (a) => {
        const files = [await filepayload(a.color, "color")];
        if (a.normal) files.push(await filepayload(a.normal, "normal"));
        if (a.arm) files.push(await filepayload(a.arm, "arm"));
        return doImport({ kind: "texture", name: a.name, files });
      } },
    { name: "editor_import_model", description: "Import a glTF model (a .glb, or a .gltf plus its .bin) into public/assets/models/<name>/. The glTF is stripped to geometry and a library material is created per glTF material slot (named after the slot), with meta.materials wired up, so the model loads and renders immediately. To texture a slot, import a texture set (editor_import_texture) named exactly after that slot — the auto-created material already points at it.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, files: { type: "array", items: { type: "string" }, description: "local file paths" } }, required: ["name", "files"] },
      run: async (a) => doImport({ kind: "model", name: a.name, files: await Promise.all((a.files as string[]).map((p) => filepayload(p))) }) },
    { name: "editor_import_audio", description: "Import an audio clip into public/assets/audio/.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["file"] },
      run: async (a) => doImport({ kind: "audio", name: a.name || "", files: [await filepayload(a.file)] }) },
    { name: "editor_import_hdri", description: "Import an HDRI (.hdr) into public/assets/hdri/.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["file"] },
      run: async (a) => doImport({ kind: "hdri", name: a.name || "", files: [await filepayload(a.file)] }) },

    // ── materials (created/edited in the editor; a texture is applied via a material,
    // never directly on geometry). File tools → run headless against the repo. ──
    { name: "editor_list_materials", description: "List materials with their full defs (type + params).", inputSchema: { type: "object", properties: {} },
      run: () => ({ materials: scanAssets(root).materials }) },
    { name: "editor_get_material", description: "Get one material's def by name.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (a) => { const m = scanAssets(root).materials.find((x) => x.name === a.name); if (!m) throw new Error(`material not found: ${a.name}`); return m; } },
    { name: "editor_create_material", description: "Create a new material (default gray `standard`, or a `water`/`glass`). Returns its name.",
      inputSchema: { type: "object", properties: { type: { type: "string", enum: ["standard", "water", "glass"] } } },
      run: (a) => { const r = createMaterial(root, a.type); if (r.error) throw new Error(r.error); bridge.notify("reloadCatalog"); return r; } },
    { name: "editor_update_material", description: "Overwrite a material's def. `def` is a full MaterialDef ({type, …params}).",
      inputSchema: { type: "object", properties: { name: { type: "string" }, def: { type: "object" } }, required: ["name", "def"] },
      run: (a) => { const r = saveMaterial(root, a.name, a.def as MaterialDef); if (r.error) throw new Error(r.error); bridge.notify("reloadCatalog"); return r; } },
    { name: "editor_rename_material", description: "Rename a material file.",
      inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
      run: (a) => { const r = renameMaterial(root, a.from, a.to); if (r.error) throw new Error(r.error); bridge.notify("reloadCatalog"); return r; } },
    { name: "editor_delete_material", description: "Delete a material file.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (a) => { const r = deleteMaterial(root, a.name); if (r.error) throw new Error(r.error); bridge.notify("reloadCatalog"); return r; } },

    // ── model calibration + collision (models/<name>/meta.json) ──
    { name: "editor_get_model_meta", description: "Get a model's calibration meta (base/scale/material/collision).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (a) => { const m = scanAssets(root).models.find((x) => x.name === a.name); if (!m) throw new Error(`model not found: ${a.name}`); return { name: m.name, meta: m.meta ?? {} }; } },
    { name: "editor_set_model_meta", description: "Set a model's calibration + collision. `baseRot` is a baked orientation (euler degrees). `collision` is \"auto\" (whole-mesh box) or \"manual\"; when manual, `collisionBoxes` is an array of solids in model-local space, each { at:[x,y,z], size:[x,y,z], rot?:[x,y,z] euler degrees, shape?: \"box\"|\"cylinder\"|\"sphere\" } (e.g. just a tree trunk, or a diagonal beam via `rot`).",
      inputSchema: { type: "object", properties: {
        name: { type: "string" }, base: { type: "number" }, scale: { type: "number" },
        materials: { type: "object", description: "per-slot material map { glTF-material-slot-name: materialName }; this is what the renderer uses for multi-material models" },
        material: { type: "string", description: "legacy: one material applied to every slot; prefer `materials`" },
        baseRot: V3,
        collision: { type: "string", enum: ["auto", "manual"] },
        collisionBoxes: { type: "array", items: { type: "object", properties: {
          at: V3, size: V3, rot: V3, shape: { type: "string", enum: ["box", "cylinder", "sphere"] },
        }, required: ["at", "size"] } },
      }, required: ["name"] },
      run: (a) => {
        const cur = scanAssets(root).models.find((x) => x.name === a.name);
        if (!cur) throw new Error(`model not found: ${a.name}`);
        const meta: ModelMeta = { ...(cur.meta ?? {}) };
        if (a.base !== undefined) meta.base = a.base;
        if (a.scale !== undefined) meta.scale = a.scale;
        if (a.materials !== undefined && a.materials && typeof a.materials === "object") meta.materials = a.materials as Record<string, string>;
        if (a.material !== undefined) meta.material = a.material || undefined;
        if (a.baseRot !== undefined) meta.baseRot = a.baseRot as [number, number, number];
        if (a.collision !== undefined) meta.collision = a.collision;
        if (a.collisionBoxes !== undefined) meta.collisionBoxes = a.collisionBoxes as CollisionBox[];
        const r = saveModelMeta(root, a.name, meta);
        if (r.error) throw new Error(r.error);
        bridge.notify("reloadCatalog");
        return r;
      } },
    { name: "editor_delete_model", description: "Delete a model folder (public/assets/models/<name>/).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (a) => { const r = deleteModel(root, a.name); if (r.error) throw new Error(r.error); bridge.notify("reloadCatalog"); return r; } },
    { name: "editor_delete_texture", description: "Delete a texture folder (public/assets/textures/<name>/).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (a) => { const r = deleteTexture(root, a.name); if (r.error) throw new Error(r.error); bridge.notify("reloadCatalog"); return r; } },

    // ── viewport tabs (live: the open editor page) ──
    { name: "editor_list_tabs", description: "List open viewport tabs (maps + material/model/texture previews).", inputSchema: { type: "object", properties: {} },
      run: () => live("listTabs") },
    { name: "editor_open_tab", description: "Open (or focus) a viewport tab. `kind`: material/model/texture (needs `name`) or map (needs `file`).",
      inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["material", "model", "texture", "map"] }, name: { type: "string" }, file: { type: "string" } }, required: ["kind"] },
      run: (a) => live("openTab", { kind: a.kind, name: a.name, file: a.file }) },
    { name: "editor_focus_tab", description: "Focus a viewport tab by id (see editor_list_tabs).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (a) => live("focusTab", { id: a.id }) },
    { name: "editor_close_tab", description: "Close a viewport tab by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (a) => live("closeTab", { id: a.id }) },
    { name: "editor_set_model_view", description: "Set a model tab's sub-view: \"model\" (geometry) or \"collision\" (author solids). Defaults to the active model tab.",
      inputSchema: { type: "object", properties: { view: { type: "string", enum: ["model", "collision"] }, id: { type: "string" } }, required: ["view"] },
      run: (a) => live("setModelView", { view: a.view, id: a.id }) },

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

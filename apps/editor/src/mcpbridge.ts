// ─── MCP bridge (editor side) ────────────────────────────────────────────────
// Polls the Tauri backend for commands enqueued by the external MCP server and
// executes them against the live editor: reading/adding/moving/deleting objects,
// editing params, importing assets, driving the viewport camera, and grabbing
// screenshots. Results are posted back so the MCP tool call resolves. This is how
// Claude Code / Codex / other agents "act in the editor" while it's open. The
// command queue lives in the Rust backend (src-tauri/src/mcp.rs), which also runs
// the local HTTP endpoint the stdio MCP server talks to — so the app is fully
// self-contained, no Vite dev server required.
import { invoke } from "@tauri-apps/api/core";
import type { AssetCatalog, Placement, Tuple3 } from "@slopwars/shared";
import { objectCatalog, objectTypeNames } from "@game/objects";
import { state } from "./state";
import { api } from "./api";
import type { Viewport } from "./viewport";
import { toast } from "./ui";

export interface McpBridgeCtx {
  viewport: Viewport;
  getCatalog: () => AssetCatalog;
  reloadCatalog: () => Promise<AssetCatalog>;
  saveMap: () => Promise<void>;
  loadMap: (file: string) => Promise<void>;
  newMap: () => void;
}

interface Cmd { op: string; [k: string]: unknown }

/** start the poll loop; safe no-op if the backend bridge isn't reachable */
export function startMcpBridge(ctx: McpBridgeCtx): void {
  let announced = false;
  const loop = async (): Promise<void> => {
    try {
      const cmds = await invoke<{ id: string; cmd: Cmd }[]>("mcp_poll");
      for (const { id, cmd } of cmds) {
        if (!announced) { announced = true; toast("MCP connected"); }
        let result: unknown;
        try { result = await run(ctx, cmd); }
        catch (e) { result = { error: String(e) }; }
        await invoke("mcp_result", { id, result });
      }
    } catch { /* backend not ready — retry */ }
    setTimeout(loop, 200);
  };
  void loop();
}

/** serialize a placement for tool responses (index-tagged) */
function objInfo(o: Placement, i: number): Record<string, unknown> {
  return { index: i, type: o.type, name: o.name ?? null, at: o.at, rot: o.rot ?? [0, 0, 0], scale: o.scale ?? [1, 1, 1], params: o.params ?? {}, group: o.group ?? null };
}

function requireMap(): NonNullable<typeof state.map> {
  if (!state.map) throw new Error("no map loaded");
  return state.map;
}
function objAt(index: number): Placement {
  const map = requireMap();
  const o = map.objects[index];
  if (!o) throw new Error(`no object at index ${index}`);
  return o;
}

async function run(ctx: McpBridgeCtx, cmd: Cmd): Promise<unknown> {
  const vp = ctx.viewport;
  switch (cmd.op) {
    case "ping":
    case "getState": {
      const map = state.map;
      return { ok: true, map: map ? { id: map.meta.id, name: map.meta.name } : null, objectCount: map?.objects.length ?? 0, camera: vp.cameraState() };
    }
    case "listObjects":
      return { objects: requireMap().objects.map(objInfo) };
    case "getObject":
      return objInfo(objAt(cmd.index as number), cmd.index as number);
    case "listObjectTypes":
      return { types: objectCatalog().map((o) => ({ name: o.name, category: o.category, defaults: o.defaults })) };
    case "listAssets": {
      const c = ctx.getCatalog();
      return { models: c.models.map((m) => m.name), textures: c.textures.map((t) => t.name), audio: c.audio.map((a) => a.name), hdri: c.hdri.map((h) => h.name), objectTypes: objectTypeNames() };
    }
    case "getMap":
      return requireMap();

    case "addObject": {
      const o = cmd.object as Placement;
      if (!o || typeof o.type !== "string") throw new Error("addObject needs { object: { type, at, … } }");
      if (!objectTypeNames().includes(o.type)) throw new Error(`unknown object type: ${o.type}`);
      if (!Array.isArray(o.at)) o.at = [0, 0, 0];
      const i = state.add(o);
      return { ok: true, index: i };
    }
    case "updateObject": {
      const o = objAt(cmd.index as number);
      const p = (cmd.patch ?? {}) as Partial<Placement>;
      if (p.at) o.at = p.at as Tuple3;
      if (p.rot) o.rot = p.rot as Tuple3;
      if (p.scale) o.scale = p.scale as Tuple3;
      if (typeof p.name === "string") o.name = p.name || undefined;
      if (typeof p.group === "string" || p.group === undefined) o.group = p.group;
      if (p.params) o.params = { ...(o.params ?? {}), ...(p.params as Record<string, unknown>) };
      state.commit(true);
      return { ok: true, object: objInfo(o, cmd.index as number) };
    }
    case "deleteObject":
      state.remove(cmd.index as number);
      return { ok: true };
    case "duplicateObject":
      state.duplicate(cmd.index as number);
      return { ok: true, index: state.selIndex };
    case "selectObject":
      state.select(cmd.index as number, "outliner");
      return { ok: true };
    case "listGroups":
      return { groups: state.groups() };

    case "import": {
      const result = await api.importAsset(cmd.req as Parameters<typeof api.importAsset>[0]);
      if (!result.error) await ctx.reloadCatalog();
      return result;
    }

    case "cameraState":
      return vp.cameraState();
    case "cameraFocus": {
      const at = cmd.at as Tuple3;
      vp.focus(at[0], at[1], at[2], typeof cmd.dist === "number" ? cmd.dist : 14);
      return { ok: true, camera: vp.cameraState() };
    }
    case "cameraSet":
      vp.setCamera(cmd.pos as Tuple3 | undefined, cmd.yaw as number | undefined, cmd.pitch as number | undefined);
      return { ok: true, camera: vp.cameraState() };
    case "cameraMove":
      vp.moveCamera((cmd.dYaw as number) ?? 0, (cmd.dPitch as number) ?? 0, (cmd.dolly as number) ?? 0);
      return { ok: true, camera: vp.cameraState() };
    case "focusSelection":
      vp.focusSelected();
      return { ok: true, camera: vp.cameraState() };
    case "screenshot":
      return { ok: true, dataUrl: vp.screenshot() };

    case "saveMap":
      await ctx.saveMap();
      return { ok: true };
    case "loadMap":
      await ctx.loadMap(cmd.file as string);
      return { ok: true };
    case "newMap":
      ctx.newMap();
      return { ok: true };

    default:
      throw new Error(`unknown op: ${cmd.op}`);
  }
}

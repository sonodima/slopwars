// ─── MCP bridge (editor side) ────────────────────────────────────────────────
// Long-polls the editor host for *live* commands — ones that need the running
// page: reading/adding/moving/deleting objects, editing params, driving the
// viewport camera, grabbing screenshots, and map save/load/new. Results are
// posted back so the MCP tool call resolves. The MCP server lives in the host
// (apps/editor/host/); file tools like asset import run there directly and never
// reach this bridge. This is how Claude Code / Codex / other agents "act in the
// editor" while it's open.
import type { AssetCatalog, Placement, Tuple3 } from "@slopwars/shared";
import { objectCatalog, objectTypeNames } from "@game/objects";
import { state } from "./state";
import { tabs, type ModelView } from "./tabs";
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

/** start the poll loop; safe no-op if the dev endpoints aren't reachable */
export function startMcpBridge(ctx: McpBridgeCtx): void {
  let announced = false;
  const loop = async (): Promise<void> => {
    try {
      const res = await fetch("/__editor/bridge/poll");
      if (res.ok) {
        const cmds = (await res.json()) as { id: string; cmd: Cmd }[];
        for (const { id, cmd } of cmds) {
          if (!announced) { announced = true; toast("MCP connected"); }
          let result: unknown;
          try { result = await run(ctx, cmd); }
          catch (e) { result = { error: String(e) }; }
          await fetch("/__editor/bridge/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, result }) });
        }
      }
    } catch { /* dev server not ready / offline — retry */ }
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
/** indices (into map.objects) of every object recursively in a group */
function memberIndicesOf(groupId: string): number[] {
  const objs = state.map?.objects ?? [];
  const members = new Set(state.membersOf(groupId, true));
  return objs.map((o, i) => (members.has(o) ? i : -1)).filter((i) => i >= 0);
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
      return { models: c.models.map((m) => m.name), textures: c.textures.map((t) => t.name), materials: c.materials.map((m) => m.name), audio: c.audio.map((a) => a.name), hdri: c.hdri.map((h) => h.name), objectTypes: objectTypeNames() };
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
      tabs.focusMapDoc(state.activeDocId);   // bring the map into view
      return { ok: true };
    case "listGroups":
      return { groups: state.groups() };
    case "getGroup": {
      const g = state.groupById(cmd.id as string);
      if (!g) throw new Error(`no group ${cmd.id as string}`);
      return { group: g, world: state.groupWorld(g.id), memberIndices: memberIndicesOf(g.id) };
    }
    case "createGroup": {
      // group the given object indices (or the current selection if none given)
      const idxs = cmd.objects as number[] | undefined;
      if (Array.isArray(idxs)) {
        const map = requireMap();
        const objs = idxs.map((i) => map.objects[i]).filter((o): o is Placement => !!o);
        if (!objs.length) throw new Error("createGroup: no valid object indices");
        state.selectSet(objs);
      }
      const id = state.createGroup(typeof cmd.name === "string" ? cmd.name : undefined);
      if (!id) throw new Error("createGroup: nothing selected to group");
      return { ok: true, id };
    }
    case "updateGroup": {
      const g = state.groupById(cmd.id as string);
      if (!g) throw new Error(`no group ${cmd.id as string}`);
      const p = (cmd.patch ?? {}) as Record<string, unknown>;
      if (typeof p.name === "string") state.renameGroup(g.id, p.name);
      if (typeof p.parent === "string" || p.parent === null) state.setGroupParent(g.id, (p.parent as string) || undefined);
      if (p.physics !== undefined || p.mass !== undefined) {
        if (p.physics !== undefined) g.physics = p.physics ? true : undefined;
        if (typeof p.mass === "number") g.mass = p.mass;
        if (g.physics && g.mass == null) g.mass = 8;
        state.commit(true);
      }
      if (p.at || p.rot || p.scale) {
        const w = state.groupWorld(g.id);
        state.setGroupWorld(g.id, { at: (p.at as Tuple3) ?? w.at, rot: (p.rot as Tuple3) ?? w.rot, scale: (p.scale as Tuple3) ?? w.scale });
      }
      return { ok: true, group: state.groupById(g.id) };
    }
    case "deleteGroup":
      state.deleteGroup(cmd.id as string);
      return { ok: true };
    case "ungroup":
      state.ungroup(cmd.id as string);
      return { ok: true };
    case "setObjectGroup": {
      const o = objAt(cmd.index as number);
      state.setObjectGroup(o, (cmd.group as string) || undefined);
      return { ok: true };
    }

    // ── viewport tabs (map / material / model documents) ──
    case "listTabs":
      return {
        tabs: tabs.tabs.map((t) => ({ id: t.id, kind: t.kind, name: t.material ?? t.model ?? (t.kind === "map" ? state.mapName(t.id) : ""), view: t.view ?? null, active: t.id === tabs.activeId })),
        activeId: tabs.activeId,
      };
    case "openTab": {
      const kind = cmd.kind as string;
      const name = cmd.name as string | undefined;
      let id: string;
      if (kind === "material") id = tabs.openMaterial(String(name));
      else if (kind === "model") id = tabs.openModel(String(name));
      else if (kind === "texture") id = tabs.openTexture(String(name));
      else if (kind === "map") { await ctx.loadMap(cmd.file as string); id = tabs.activeId; }
      else throw new Error(`unknown tab kind: ${kind}`);
      return { ok: true, id };
    }
    case "focusTab":
      tabs.focus(cmd.id as string);
      return { ok: true, activeId: tabs.activeId };
    case "closeTab":
      tabs.close(cmd.id as string);
      return { ok: true, activeId: tabs.activeId };
    case "setModelView": {
      const view = cmd.view as ModelView;
      const t = cmd.id ? tabs.find(cmd.id as string) : tabs.active();
      if (!t || t.kind !== "model") throw new Error("no active model tab");
      tabs.setModelView(t.id, view);
      return { ok: true };
    }

    // asset imports run server-side in the host (headless, no editor window
    // required); the host fires this so an open editor refreshes its browser.
    case "reloadCatalog":
      await ctx.reloadCatalog();
      return { ok: true };

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

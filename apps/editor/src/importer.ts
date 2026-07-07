// ─── Asset import dialogs ────────────────────────────────────────────────────
// Modal flows for bringing new assets into the project from local files. Each
// dialog collects the right pieces for its kind — a PBR texture set (color /
// normal / arm), a glTF model (+ its .bin / textures), a single audio clip, or an
// HDRI — reads them as base64 in the browser, and POSTs to the dev server which
// writes them into public/assets/<kind>/ (the same git-first layout the scanner
// discovers). On success the caller reloads the catalog so the asset appears.
//
// Every file slot is a drop zone: drag files straight from Finder/Explorer onto
// it (or click to browse). The texture dialog goes further — dropping several
// maps at once auto-sorts them into color/normal/arm by filename, and fills the
// asset name from the color map — so a full PBR set is one drag away.
import { api, type ImportFile } from "./api";
import { el, modal, toast } from "./ui";

export type ImportKind = "texture" | "model" | "audio" | "hdri";

/** read a File as a base64 string (no data-url prefix) */
function readB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** a drop zone that also opens a file picker on click. Returns its row plus a
 *  getter for the chosen File(s) and a `set` to fill it programmatically (used by
 *  the texture dialog's auto-sort). `onFiles` fires whenever the selection changes. */
interface DropZone { row: HTMLElement; files: () => File[]; set: (f: File[]) => void }
function dropZone(label: string, accept: string, multiple: boolean, onFiles?: (f: File[]) => void): DropZone {
  const row = el("div", "imp-row");
  row.append(el("label", "imp-label", label));
  const zone = el("div", "imp-drop");
  const hint = el("span", "imp-drop-hint");
  const input = el("input") as HTMLInputElement;
  input.type = "file"; input.accept = accept; input.multiple = multiple; input.style.display = "none";
  zone.append(hint, input);
  row.append(zone);

  let chosen: File[] = [];
  const render = (): void => {
    if (chosen.length) { hint.textContent = chosen.map((f) => f.name).join(", "); zone.classList.add("has"); }
    else { hint.textContent = multiple ? "Drop files here or click to browse" : "Drop a file here or click to browse"; zone.classList.remove("has"); }
  };
  const set = (f: File[]): void => { chosen = multiple ? f : f.slice(0, 1); render(); onFiles?.(chosen); };

  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => set(Array.from(input.files ?? [])));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drop"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drop"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); zone.classList.remove("drop");
    const f = Array.from(e.dataTransfer?.files ?? []);
    if (f.length) set(f);
  });
  render();
  return { row, files: () => chosen, set };
}

function textRow(label: string, placeholder: string): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("div", "imp-row");
  row.append(el("label", "imp-label", label));
  const input = el("input", "imp-text") as HTMLInputElement;
  input.type = "text"; input.placeholder = placeholder;
  row.append(input);
  return { row, input };
}

/** open the right import dialog for a kind; resolves the imported asset name (or
 *  null if cancelled) after the catalog-reload the caller triggers via onDone. */
export function openImport(kind: ImportKind, onDone: () => void): void {
  if (kind === "texture") return importTexture(onDone);
  if (kind === "model") return importModel(onDone);
  if (kind === "audio") return importAudioOrHdri("audio", onDone);
  return importAudioOrHdri("hdri", onDone);
}

function footer(submit: () => void, dlg: { close: () => void }): HTMLElement {
  const bar = el("div", "imp-actions");
  const cancel = el("button", "btn", "Cancel");
  cancel.addEventListener("click", () => dlg.close());
  const ok = el("button", "btn primary", "Import");
  ok.addEventListener("click", submit);
  bar.append(cancel, ok);
  return bar;
}

async function send(kind: ImportKind, name: string, files: ImportFile[], dlg: { close: () => void }, onDone: () => void): Promise<void> {
  try {
    const res = await api.importAsset({ kind, name, files });
    if (res.error) { toast("import failed: " + res.error, true); return; }
    toast(`imported ${kind} “${res.name}”`);
    dlg.close();
    onDone();
  } catch (e) { toast("import failed: " + e, true); }
}

/** strip an extension + common PBR-map suffixes to guess a set name from a file */
function baseName(file: string): string {
  return file.replace(/\.[^.]+$/, "").replace(/[ _-]?(color|albedo|basecolor|diffuse|normal|nrm|arm|orm|ao|roughness|metallic)$/i, "");
}
/** classify a texture file into a PBR slot by its name (null if unclear) */
function guessSlot(file: string): "color" | "normal" | "arm" | null {
  const n = file.toLowerCase();
  if (/(normal|nrm|_n\.)/.test(n)) return "normal";
  if (/(arm|orm|ao|rough|metal|_m\.)/.test(n)) return "arm";
  if (/(color|albedo|basecolor|diffuse|_c\.|_d\.)/.test(n)) return "color";
  return null;
}

function importTexture(onDone: () => void): void {
  const body = el("div", "imp-body");
  const name = textRow("Name", "e.g. brick_wall");
  // auto-fill the set name from the first map dropped, if the user hasn't typed one
  const autoName = (files: File[]): void => {
    if (!name.input.value.trim() && files[0]) name.input.value = baseName(files[0].name);
  };
  const color = dropZone("Color / albedo", "image/*", false, autoName);
  const normal = dropZone("Normal (optional)", "image/*", false);
  const arm = dropZone("AO·Rough·Metal (optional)", "image/*", false);
  const slots = { color, normal, arm };

  body.append(
    el("div", "imp-hint", "A PBR texture set → public/assets/textures/<name>/. Drop all three maps at once and they’re sorted by filename."),
    name.row, color.row, normal.row, arm.row,
  );
  const dlg = modal("Import texture", body);

  // drop several files anywhere on the dialog → auto-route each to its slot
  body.addEventListener("dragover", (e) => { e.preventDefault(); });
  body.addEventListener("drop", (e) => {
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length < 2) return;   // single-file drops belong to the slot under the cursor
    e.preventDefault(); e.stopPropagation();
    const empty: ("color" | "normal" | "arm")[] = ["color", "normal", "arm"];
    for (const f of dropped) {
      let slot = guessSlot(f.name);
      if (!slot || slots[slot].files().length) slot = empty.find((s) => !slots[s].files().length) ?? null;
      if (slot) slots[slot].set([f]);
    }
    autoName(color.files());
  });

  body.append(footer(async () => {
    const files: ImportFile[] = [];
    for (const [zone, slot] of [[color, "color"], [normal, "normal"], [arm, "arm"]] as const) {
      const f = zone.files()[0];
      if (f) files.push({ name: f.name, slot, data: await readB64(f) });
    }
    if (!name.input.value.trim()) { toast("enter a name", true); return; }
    if (!files.length) { toast("pick at least a color map", true); return; }
    await send("texture", name.input.value.trim(), files, dlg, onDone);
  }, dlg));
}

function importModel(onDone: () => void): void {
  const body = el("div", "imp-body");
  const name = textRow("Name", "e.g. crate_new");
  const files = dropZone("Files (.gltf/.glb + .bin + textures)", ".gltf,.glb,.bin,image/*", true, (f) => {
    if (!name.input.value.trim()) { const g = f.find((x) => /\.(gltf|glb)$/i.test(x.name)); if (g) name.input.value = baseName(g.name); }
  });
  body.append(
    el("div", "imp-hint", "A glTF model → public/assets/models/<name>/. Drop the .gltf/.glb and any .bin / texture files it references (or a single self-contained .glb)."),
    name.row, files.row,
  );
  const dlg = modal("Import model", body);
  body.append(footer(async () => {
    const list = files.files();
    if (!name.input.value.trim()) { toast("enter a name", true); return; }
    if (!list.length) { toast("pick model files", true); return; }
    const payload: ImportFile[] = [];
    for (const f of list) payload.push({ name: f.name, data: await readB64(f) });
    await send("model", name.input.value.trim(), payload, dlg, onDone);
  }, dlg));
}

function importAudioOrHdri(kind: "audio" | "hdri", onDone: () => void): void {
  const body = el("div", "imp-body");
  const name = textRow("Name (optional)", "defaults to file name");
  const accept = kind === "audio" ? "audio/*" : ".hdr,.exr";
  const dest = kind === "audio" ? "public/assets/audio/" : "public/assets/hdri/";
  const file = dropZone(kind === "audio" ? "Audio clip" : "HDRI (.hdr)", accept, false);
  body.append(el("div", "imp-hint", `A single ${kind} file → ${dest}`), name.row, file.row);
  const dlg = modal(`Import ${kind}`, body);
  body.append(footer(async () => {
    const f = file.files()[0];
    if (!f) { toast("pick a file", true); return; }
    await send(kind, name.input.value.trim(), [{ name: f.name, data: await readB64(f) }], dlg, onDone);
  }, dlg));
}

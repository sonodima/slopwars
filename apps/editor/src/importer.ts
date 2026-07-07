// ─── Asset import dialogs ────────────────────────────────────────────────────
// Modal flows for bringing new assets into the project from local files. Each
// dialog collects the right pieces for its kind — a PBR texture set (color /
// normal / arm), a glTF model (+ its .bin / textures), a single audio clip, or an
// HDRI — reads them as base64 in the browser, and POSTs to the dev server which
// writes them into public/assets/<kind>/ (the same git-first layout the scanner
// discovers). On success the caller reloads the catalog so the asset appears.
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

/** a labelled file input; returns the row + a getter for the chosen File */
function fileRow(label: string, accept: string, multiple = false): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("div", "imp-row");
  row.append(el("label", "imp-label", label));
  const input = el("input", "imp-file") as HTMLInputElement;
  input.type = "file"; input.accept = accept; input.multiple = multiple;
  row.append(input);
  return { row, input };
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

function importTexture(onDone: () => void): void {
  const body = el("div", "imp-body");
  const name = textRow("Name", "e.g. brick_wall");
  const color = fileRow("Color / albedo", "image/*");
  const normal = fileRow("Normal (optional)", "image/*");
  const arm = fileRow("AO·Rough·Metal (optional)", "image/*");
  body.append(el("div", "imp-hint", "A PBR texture set → public/assets/textures/<name>/"), name.row, color.row, normal.row, arm.row);
  const dlg = modal("Import texture", body);
  body.append(footer(async () => {
    const files: ImportFile[] = [];
    for (const [inp, slot] of [[color.input, "color"], [normal.input, "normal"], [arm.input, "arm"]] as const) {
      const f = inp.files?.[0];
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
  const files = fileRow("Files (.gltf/.glb + .bin + textures)", ".gltf,.glb,.bin,image/*", true);
  body.append(
    el("div", "imp-hint", "A glTF model → public/assets/models/<name>/. Select the .gltf/.glb and any .bin / texture files it references (or a single self-contained .glb)."),
    name.row, files.row,
  );
  const dlg = modal("Import model", body);
  body.append(footer(async () => {
    const list = Array.from(files.input.files ?? []);
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
  const file = fileRow(kind === "audio" ? "Audio clip" : "HDRI (.hdr)", accept);
  body.append(el("div", "imp-hint", `A single ${kind} file → ${dest}`), name.row, file.row);
  const dlg = modal(`Import ${kind}`, body);
  body.append(footer(async () => {
    const f = file.input.files?.[0];
    if (!f) { toast("pick a file", true); return; }
    await send(kind, name.input.value.trim(), [{ name: f.name, data: await readB64(f) }], dlg, onDone);
  }, dlg));
}

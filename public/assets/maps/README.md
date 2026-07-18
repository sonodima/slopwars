# Maps

Playable maps live here, alongside every other asset (`models/`, `textures/`, …), and are
discovered by scanning this directory (`scanMaps` in
`packages/shared/src/vite-asset-catalog.ts`). Because this is inside the game's `publicDir`,
Vite serves the files in dev and copies them into the build automatically.

A map is a folder:

```
assets/maps/<id>/
  map.json          # the MapDef (meta + env + objects)
  preview.jpg       # screenshot shown in the map picker (optional)
  preview-2.jpg …   # add more images for a multi-shot gallery (optional)
```

The map JSON is `map.json` (or `<id>.json`); its top-level `meta` block gives the map its
`id`, `name`, `theme` and rotation flag. **Previews are plain image files** — drop any
`.jpg` / `.jpeg` / `.png` / `.webp` / `.avif` into the folder and it shows up as a thumbnail
in the lobby map picker and the between-rounds vote. No manifest needed: a file named
`preview.*` is used first, then the rest alphabetically.

That's it — exactly like the rest of the file-driven asset pipeline: add the files, commit,
and they're available to the game and the editor with no code changes.

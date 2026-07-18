/// <reference types="vite/client" />

// Build identity injected by the `define` block in vite.config.ts ("dev" outside a
// git checkout). Only reference these from modules the editor never imports.
declare const __GAME_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __PKG_VERSION__: string;

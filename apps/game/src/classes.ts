// ─── Loadout classes: Krunker-style preset kits picked per player ─────────────
// The game is a fast, arena/movement shooter with instant (or short-delay) respawns
// and *timed* rounds — not CS-style elimination rounds. A CS buy economy needs
// round-based eliminations, per-round money and a freeze/buy phase, none of which
// fit this respawn loop. So the "weapon economy" here is a **class system** (à la
// Krunker): each player picks a preset kit — primary / secondary / melee / utility —
// that they respawn with every life. It's zero-bookkeeping, reads instantly on the
// HUD, and slots cleanly into the existing per-spawn loadout code.
//
// Adding a class is one entry in CLASSES; adding a weapon to a kit is one WeaponId in
// its `loadout`. Nothing else needs to change — the weapon system builds a viewmodel
// for every weapon and simply activates the class's subset.
import { WeaponId } from "./types";

export type ClassId = "assault" | "rifleman" | "recon" | "raider" | "breacher" | "voidwalker";

export interface ClassDef {
  id: ClassId;
  name: string;
  blurb: string;
  /** ordered inventory: primary, secondary, melee, then utility (throwables). The first
   *  entry is what the player spawns holding. Weapon-slot keys 1..N map onto this order. */
  loadout: WeaponId[];
}

export const CLASSES: Record<ClassId, ClassDef> = {
  assault: {
    id: "assault", name: "Assault", blurb: "M4A1 · USP · frag — the reliable all-rounder.",
    loadout: ["m4a1", "usp", "knife", "he"],
  },
  rifleman: {
    id: "rifleman", name: "Rifleman", blurb: "AK-47 hits hard. Luger backup, molotov to zone.",
    loadout: ["ak47", "luger", "knife", "mol"],
  },
  recon: {
    id: "recon", name: "Recon", blurb: "AWP one-taps. USP + smoke to reposition.",
    loadout: ["awp", "usp", "knife", "smoke"],
  },
  raider: {
    id: "raider", name: "Raider", blurb: "Suomi SMG runner. Luger + flash to entry.",
    loadout: ["suomi", "luger", "knife", "flash"],
  },
  breacher: {
    id: "breacher", name: "Breacher", blurb: "Shotgun up close, Grease Gun spray, frag to clear.",
    loadout: ["shotgun", "grease", "knife", "he"],
  },
  voidwalker: {
    id: "voidwalker", name: "Voidwalker", blurb: "Suomi + portal gun — link two rifts, flank through.",
    loadout: ["suomi", "luger", "knife", "portalgun"],
  },
};

export const CLASS_LIST: ClassId[] = ["assault", "rifleman", "recon", "raider", "breacher", "voidwalker"];
export const DEFAULT_CLASS: ClassId = "assault";

export function classById(id: string | undefined): ClassDef {
  return CLASSES[id as ClassId] ?? CLASSES[DEFAULT_CLASS];
}

/** a random class id (bots roll one each life so their kits vary) */
export function randomClass(): ClassId {
  return CLASS_LIST[(Math.random() * CLASS_LIST.length) | 0];
}

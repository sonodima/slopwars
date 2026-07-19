# App icon

`AppIcon.icon` is the Icon Composer source (macOS 26 liquid-glass icon). The
two compiled artifacts next to it are committed so CI never needs Xcode:

- `Assets.car` — compiled icon catalog; loaded on macOS 26+ via
  `CFBundleIconName` (see `mac.extendInfo` in package.json) for the native
  glass rendering.
- `icon.icns` — flat fallback for older macOS, generated from the pre-rendered
  tile export of the same design (also the source of `public/icons/*` and the
  favicon `public/logo.png`; win/linux builds reuse `public/icons/icon-512.png`).

Regenerate `Assets.car` after editing `AppIcon.icon` (needs Xcode 26+):

```sh
xcrun actool AppIcon.icon --compile . --app-icon AppIcon --include-all-app-icons \
  --platform macosx --minimum-deployment-target 12.0 \
  --output-partial-info-plist /tmp/partial.plist
```

(actool's own `.icns` output only carries reps up to 256px — too small for
Finder/Dock, which is why `icon.icns` is built separately from the 1118px tile
export via `iconutil`.)

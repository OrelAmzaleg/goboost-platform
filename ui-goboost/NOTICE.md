# NOTICE — Attribution for `ui-goboost`

This package is **derived from [pixel-agents](https://github.com/pablodelucca/pixel-agents)** by Pablo de Lucca, used under the MIT License.

## What was lifted

The contents of `ui-goboost/` were copied (and then modified) from:
- `pixel-agents/webview-ui/` — the React + Vite renderer, Canvas 2D engine, character state machine, layout editor, pathfinding
- `pixel-agents/shared/` — asset decoder/builder utilities (PNG decoding, manifest parsing, furniture catalog)

The Metro City character pack included under `public/assets/characters/` is the work of **JIK-A-4** ([Metro City asset pack](https://itch.io/) — please consult the pixel-agents upstream for the canonical reference).

## What was changed

- Removed the VS Code extension host (`pixel-agents/src/`) — `ui-goboost` runs as a standalone web app in a browser
- The VS Code messaging bridge in `src/vscodeApi.ts` already had a built-in browser fallback (console.log stub) — no patch needed there
- `vite.config.ts`: changed shared/ import path, build outDir, added dev port 3200
- `package.json`: renamed to `@goboost/ui-goboost`, added GoBoost description
- `index.html`: switched to Hebrew RTL (`<html lang="he" dir="rtl">`) with a GoBoost bootstrap banner

## Why we forked instead of installing from npm

pixel-agents is shipped as a VS Code extension, not as an npm library — there is no consumable package on the registry. We need to embed the rendering engine inside our own React app (GoBoost Platform), which requires source-level access. The MIT License explicitly permits this kind of derivative use as long as attribution and the original copyright notice are preserved.

## License compliance

- Original pixel-agents LICENSE preserved at [`LICENSE-PIXEL-AGENTS`](./LICENSE-PIXEL-AGENTS) in this directory.
- All copyright and attribution notices in source files are preserved.
- Modifications are marked with `// GoBoost:` comments where they touch upstream files.
- Our own code added to `ui-goboost/` is © 2026 GoBoost / Orel Amzaleg, also MIT.

## Upstream tracking

- Upstream repo: https://github.com/pablodelucca/pixel-agents
- Lifted at commit: (recorded in our initial commit message — `git log --grep "pixel-agents"`)
- For future updates: review upstream changes and selectively cherry-pick into `ui-goboost/`.

---

Thank you to Pablo de Lucca and JIK-A-4 for releasing this work openly. The visual quality of GoBoost Platform is built on their foundation.

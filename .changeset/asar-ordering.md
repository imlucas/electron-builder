---
"app-builder-lib": minor
---

fix(asar): `asar.ordering` is now honored — the documented option was typed but never applied to the archive electron-builder packs. Listed files are packed first, in the order of the file (same line syntax as `@electron/asar`: optional leading `/` or `<count>:` prefix), directories keep their positions, everything else follows in its original order. Composes with `asar.contentAlignment`, so apps no longer need an afterPack re-pack (which would undo alignment) to front-load startup files.

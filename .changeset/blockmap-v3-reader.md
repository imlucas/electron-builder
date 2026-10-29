---
"builder-util-runtime": minor
"electron-updater": minor
---

feat(updater): read the binary block map (v3, magic `EBB3`) that electron-builder 27 publishes (v26 backport of the reader from #10312, #10463 and #10485). electron-updater 6 now tells the two `.blockmap` formats apart by their first bytes: against a cached v3 map, only the changed parts of the new map are fetched with Range requests (a plain GET of the whole map when that fails), and differential updates work between two v3 maps. When the old and new maps are in different formats, the update is downloaded in full once (logged as info, not as an error) and the new map is cached so the next update is differential again. Gzipped JSON maps are read, requested and cached exactly as before, and electron-builder 26 keeps writing them.

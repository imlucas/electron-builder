---
"app-builder-lib": minor
---

feat(blockmap): write the binary block map for electron-updater 6.9.0 and later. The v26 line reads it from 6.9.0 on, so an `electronUpdaterCompatibility` range such as `">=6.9.0"` now keeps the binary map, and an app that ships electron-updater 6.9.0 or later passes the build check with it

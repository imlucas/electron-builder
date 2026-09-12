---
"electron-updater": minor
"builder-util-runtime": minor
---

feat(electron-updater): differential download driven by the range-fetchable block map v3

When a `latest.yml` file entry advertises `blockMapV3: true`, the updater fetches the new `<file>.blockmap3` with Range requests: the header and group table first, then only the records of groups that differ from the cached previous map (`current.blockmap3`), reconstructing the full map locally and verifying every group hash. The existing block-level differential download then runs unchanged on both maps. Any failure (HTTP error, missing Range support, parse or verification error) logs a warning and falls back to the existing v2 `.blockmap` path, which is unchanged. `Provider.getBlockMapV3Files` derives the v3 URLs (GitLab `project_upload` releases look the asset up by name), and `BlockMapDataHolder.blockMapV3` declares the flag.

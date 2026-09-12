import { log } from "builder-util"
import { BLOCK_MAP_V3_FILE_SUFFIX, BlockMapDataHolder, PackageFileInfo } from "builder-util-runtime"
import * as path from "path"
import { Target } from "../core.js"
import { PlatformPackager } from "../platformPackager.js"
import { ArchiveOptions } from "./archive.js"
import { BlockMapRegion, buildBlockMap, BuildBlockMapOptions, ChunkerParams } from "./blockmap/blockmap.js"
import { buildBlockMapV3 } from "./blockmap/blockmapV3.js"
import { findVerbatimRange } from "./blockmap/verbatimRange.js"

export const BLOCK_MAP_FILE_SUFFIX = ".blockmap"

/**
 * Chunker parameters for a stored (`Copy`) archive member — e.g. `resources/app.asar` when
 * `nsis.differentialPackage` is `"store-asar"` — whose bytes sit verbatim in the artifact. Such a member
 * changes in small, localized ways between releases, so it is chunked finer than the surrounding
 * compressed streams to keep the differential download proportional to the change.
 *
 * Set by benchmark (`test/src/differentialOneLineBenchTest.ts`, 32 MB asar / 3,001 files): 4/8/16 KiB
 * minimizes download bytes + new-blockmap bytes for a one-line edit (−5 % same-length, −17 % length-changing
 * vs. the 8/16/32 default); anything finer is a net loss because the v2 blockmap (~22 B per block, re-downloaded
 * in full on every update) grows faster than the block savings. `avg` must stay a power of two.
 */
export const STORED_MEMBER_CHUNKER: ChunkerParams = { min: 4096, avg: 8192, max: 16384 }

/**
 * `STORED_MEMBER_CHUNKER` counterpart for the v3 block map (`BLOCK_MAP_V3_FILE_SUFFIX`). A v3 map costs
 * ~10 B per block and an updater fetches only the groups that changed, so the v2 trade-off (a finer
 * chunker inflating a map that is re-downloaded in full) no longer applies and the stored member can be
 * chunked at 1/2/4 KiB: a one-line change then costs a couple of blocks plus a few KB of map.
 * `max` must fit a v3 record's 16-bit block size.
 */
export const STORED_MEMBER_CHUNKER_V3: ChunkerParams = { min: 1024, avg: 2048, max: 4096 }

/**
 * Locates each of `memberFiles` (absolute paths of files stored verbatim inside `artifact`) and returns
 * a `STORED_MEMBER_CHUNKER` blockmap region per located file, sorted by offset. A member that cannot be
 * found verbatim is logged at warn and skipped — the blockmap then falls back to the default chunker for
 * those bytes; it never fails the build.
 *
 * The returned regions are the v2 regions; `toV3Regions` derives the v3 regions (same byte ranges,
 * `STORED_MEMBER_CHUNKER_V3`) from them, so both maps are built from the same located ranges.
 */
export async function locateStoredMemberRegions(artifact: string, memberFiles: Array<string>): Promise<Array<BlockMapRegion>> {
  const regions: Array<BlockMapRegion> = []
  for (const memberFile of memberFiles) {
    const range = await findVerbatimRange(artifact, memberFile)
    if (range == null) {
      log.warn(
        { artifact: log.filePath(artifact), member: log.filePath(memberFile) },
        "stored member not found verbatim in artifact; its bytes will be chunked with the default block map parameters"
      )
      continue
    }
    log.info({ artifact: log.filePath(artifact), member: log.filePath(memberFile), offset: range.offset, size: range.size }, "located stored member region for block map")
    regions.push({ ...range, chunker: STORED_MEMBER_CHUNKER })
  }
  return regions.sort((a, b) => a.offset - b.offset)
}

/** `BuildBlockMapOptions` for `regions`, or `undefined` when there are none so the default chunker path is taken unchanged. */
export function toBlockMapOptions(regions: Array<BlockMapRegion>): BuildBlockMapOptions | undefined {
  return regions.length === 0 ? undefined : { regions }
}

function isSameChunker(a: ChunkerParams, b: ChunkerParams): boolean {
  return a.min === b.min && a.avg === b.avg && a.max === b.max
}

/**
 * The v3 block map regions for the v2 `regions` (as returned by `locateStoredMemberRegions`): the same
 * byte ranges, with `STORED_MEMBER_CHUNKER` swapped for `STORED_MEMBER_CHUNKER_V3`. Regions with any
 * other chunker are kept as they are (a caller that chose its own parameters gets them in both maps).
 */
export function toV3Regions(regions: Array<BlockMapRegion> | null | undefined): Array<BlockMapRegion> {
  return (regions ?? []).map(region => (isSameChunker(region.chunker, STORED_MEMBER_CHUNKER) ? { ...region, chunker: STORED_MEMBER_CHUNKER_V3 } : region))
}

export function createNsisWebDifferentialUpdateInfo(artifactPath: string, packageFiles: { [arch: string]: PackageFileInfo }) {
  if (packageFiles == null) {
    return null
  }

  const keys = Object.keys(packageFiles)
  if (keys.length <= 0) {
    return null
  }

  const packages: { [arch: string]: PackageFileInfo } = {}
  for (const arch of keys) {
    const packageFileInfo = packageFiles[arch]
    const file = path.basename(packageFileInfo.path)
    packages[arch] = {
      ...packageFileInfo,
      path: file,
      // https://github.com/electron-userland/electron-builder/issues/2583
      file,
    } as any
  }
  return { packages }
}

export function configureDifferentialAwareArchiveOptions(archiveOptions: ArchiveOptions): ArchiveOptions {
  /*
   * dict size 64 MB: Full: 33,744.88 KB, To download: 17,630.3 KB (52%)
   * dict size 16 MB: Full: 33,936.84 KB, To download: 16,175.9 KB (48%)
   * dict size  8 MB: Full: 34,187.59 KB, To download:  8,229.9 KB (24%)
   * dict size  4 MB: Full: 34,628.73 KB, To download: 3,782.97 KB (11%)

   as we can see, if file changed in one place, all block is invalidated (and update size approximately equals to dict size)

   1 MB is used:

   1MB:

   2018/01/11 11:54:41:0045 File has 59 changed blocks
   2018/01/11 11:54:41:0050 Full: 71,588.59 KB, To download: 1,243.39 KB (2%)

   4MB:

   2018/01/11 11:31:43:0440 Full: 70,303.55 KB, To download: 4,843.27 KB (7%)
   2018/01/11 11:31:43:0435 File has 234 changed blocks

   */
  archiveOptions.dictSize = 1
  // solid compression leads to a lot of changed blocks
  archiveOptions.solid = false
  // do not allow to change compression level to avoid different packages
  archiveOptions.compression = "normal"
  return archiveOptions
}

export async function appendBlockmap(file: string, options?: BuildBlockMapOptions): Promise<BlockMapDataHolder> {
  log.info({ file: log.filePath(file) }, "building embedded block map")
  return buildBlockMap(file, "deflate", undefined, options)
}

export async function createBlockmap(
  file: string,
  target: Target,
  packager: PlatformPackager<any>,
  safeArtifactName: string | null,
  options?: BuildBlockMapOptions
): Promise<BlockMapDataHolder> {
  const blockMapFile = `${file}${BLOCK_MAP_FILE_SUFFIX}`
  log.info({ blockMapFile: log.filePath(blockMapFile) }, "building block map")
  const updateInfo = await buildBlockMap(file, "gzip", blockMapFile, options)
  await packager.emitArtifactBuildCompleted({
    file: blockMapFile,
    safeArtifactName: safeArtifactName == null ? null : `${safeArtifactName}${BLOCK_MAP_FILE_SUFFIX}`,
    target,
    arch: null,
    packager,
    updateInfo,
  })

  // The v3 map is an additional artifact (never appended to the v2 file — old updaters gunzip + JSON.parse
  // that one). It is always built: ~10 B per block, and a v3-capable updater then fetches only the groups
  // that changed. Emitted without `updateInfo` so it is uploaded like any artifact but does not write
  // update info; `blockMapV3` on the returned holder reaches the `files[]` entry of latest.yml via the
  // main artifact's `updateInfo` (see `createUpdateInfo` in publish/updateInfoBuilder.ts).
  const blockMapV3File = `${file}${BLOCK_MAP_V3_FILE_SUFFIX}`
  log.info({ blockMapFile: log.filePath(blockMapV3File) }, "building block map v3")
  const v3 = await buildBlockMapV3(file, blockMapV3File, { regions: toV3Regions(options?.regions) })
  log.debug({ blockMapFile: log.filePath(blockMapV3File), blocks: v3.blockCount, groups: v3.groupCount }, "built block map v3")
  await packager.emitArtifactBuildCompleted({
    file: blockMapV3File,
    safeArtifactName: safeArtifactName == null ? null : `${safeArtifactName}${BLOCK_MAP_V3_FILE_SUFFIX}`,
    target,
    arch: null,
    packager,
  })
  updateInfo.blockMapV3 = true
  return updateInfo
}

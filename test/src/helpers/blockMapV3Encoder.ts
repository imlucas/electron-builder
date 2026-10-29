import { blake2b } from "@noble/hashes/blake2.js"
import {
  BLOCK_MAP_V3_MAGIC,
  BLOCK_MAP_V3_VERSION,
  BlockMapV3Region,
  ChunkerParamsV3,
  GROUP_SIZE,
  HASH_LEN,
  HEADER_FIXED_SIZE,
  IndexRange,
  RECORD_SIZE,
  REGION_SIZE,
  SUPER_SIZE,
  superHashOfGroups,
} from "builder-util-runtime/out/blockMapV3"

// The block map v3 encoder of electron-builder 27, test-only on this line: electron-builder 26 ships the reader (electron-updater 6
// can update from a v3 map published by a v27 build) but keeps writing the gzipped JSON block map, so the tests build v3 maps here.

/** Content-defined grouping parameters (in blocks). */
export const GROUP_AVG = 32
export const GROUP_MASK = GROUP_AVG - 1
export const GROUP_MIN = 8
export const GROUP_MAX = 128

/** Content-defined super-grouping parameters (in groups). */
export const SUPER_AVG = 16
export const SUPER_MASK = SUPER_AVG - 1
export const SUPER_MIN = 4
export const SUPER_MAX = 64

/** Input block for the encoder: the full blake2b-18 digest (or at least its first 8 bytes) and the block size. */
export interface BlockInput {
  digest: Uint8Array
  size: number
  /** absolute offset of the block's first byte; used only to force group boundaries at region edges */
  offset: number
}

function writeHex8(buf: Buffer, offset: number, hex: string): void {
  buf.write(hex, offset, HASH_LEN, "hex")
}

/**
 * Splits `blocks` (in file order) into content-defined groups. Boundaries are forced at every offset
 * in `forcedBoundaries` (region edges) and at the end.
 */
export function groupBlocks(blocks: Array<BlockInput>, forcedBoundaries: Set<number> = new Set()): Array<IndexRange> {
  const groups: Array<IndexRange> = []
  let start = 0
  for (let i = 0; i < blocks.length; i++) {
    const count = i - start + 1
    const next = blocks[i + 1]
    const forced = next == null || forcedBoundaries.has(next.offset)
    // the low GROUP_MASK bits of the last hash byte decide a content-defined cut
    const marker = (blocks[i].digest[HASH_LEN - 1] & GROUP_MASK) === GROUP_MASK
    if (forced || count >= GROUP_MAX || (count >= GROUP_MIN && marker)) {
      groups.push({ start, end: i + 1 })
      start = i + 1
    }
  }
  return groups
}

/**
 * Splits groups (in file order) into content-defined super-groups on the stream of group hashes.
 * `groupHashBytes[i]` is group i's 8-byte hash, `groupStartOffsets[i]` the absolute offset of its first
 * block; a boundary is forced before every group that starts at an offset in `forcedBoundaries`.
 */
export function groupSupers(groupHashBytes: Array<Uint8Array>, groupStartOffsets: Array<number>, forcedBoundaries: Set<number> = new Set()): Array<IndexRange> {
  const supers: Array<IndexRange> = []
  let start = 0
  for (let i = 0; i < groupHashBytes.length; i++) {
    const count = i - start + 1
    const forced = i + 1 >= groupHashBytes.length || forcedBoundaries.has(groupStartOffsets[i + 1])
    const marker = (groupHashBytes[i][HASH_LEN - 1] & SUPER_MASK) === SUPER_MASK
    if (forced || count >= SUPER_MAX || (count >= SUPER_MIN && marker)) {
      supers.push({ start, end: i + 1 })
      start = i + 1
    }
  }
  return supers
}

export interface EncodeOptions {
  fileSize: number
  defaultChunker: ChunkerParamsV3
  regions?: Array<BlockMapV3Region> | null
}

/** Serializes blocks (in file order) into a v3 block map buffer. */
export function encodeBlockMapV3(blocks: Array<BlockInput>, options: EncodeOptions): Buffer {
  const regions = options.regions ?? []
  const forced = new Set<number>()
  for (const region of regions) {
    forced.add(region.offset)
    forced.add(region.offset + region.size)
  }
  const groups = groupBlocks(blocks, forced)

  // records first: group hashes are hashes of record bytes, super hashes of group entry bytes
  const recordBytes = Buffer.alloc(blocks.length * RECORD_SIZE)
  let r = 0
  for (const block of blocks) {
    if (block.size > 0xffff) {
      throw new Error(`block map v3: block size ${block.size} exceeds the 16-bit record limit`)
    }
    recordBytes.set(block.digest.subarray(0, HASH_LEN), r)
    recordBytes.writeUInt16LE(block.size, r + HASH_LEN)
    r += RECORD_SIZE
  }

  const groupBytes = Buffer.alloc(groups.length * GROUP_SIZE)
  const groupHashBytes: Array<Uint8Array> = []
  const groupStartOffsets: Array<number> = []
  let g = 0
  for (const group of groups) {
    let byteLength = 0
    for (let i = group.start; i < group.end; i++) {
      byteLength += blocks[i].size
    }
    const digest = blake2b(recordBytes.subarray(group.start * RECORD_SIZE, group.end * RECORD_SIZE), { dkLen: 18 })
    groupBytes.set(digest.subarray(0, HASH_LEN), g)
    groupBytes.writeUInt32LE(byteLength, g + 8)
    groupBytes.writeUInt16LE(group.end - group.start, g + 12)
    groupBytes.writeUInt16LE(0, g + 14)
    groupHashBytes.push(digest.subarray(0, HASH_LEN))
    groupStartOffsets.push(blocks[group.start].offset)
    g += GROUP_SIZE
  }

  const supers = groupSupers(groupHashBytes, groupStartOffsets, forced)
  const superBytes = Buffer.alloc(supers.length * SUPER_SIZE)
  let s = 0
  for (const sup of supers) {
    let blockCount = 0
    for (let i = sup.start; i < sup.end; i++) {
      blockCount += groups[i].end - groups[i].start
    }
    writeHex8(superBytes, s, superHashOfGroups(groupBytes.subarray(sup.start * GROUP_SIZE, sup.end * GROUP_SIZE)))
    superBytes.writeUInt32LE(blockCount, s + 8)
    superBytes.writeUInt16LE(sup.end - sup.start, s + 12)
    superBytes.writeUInt16LE(0, s + 14)
    s += SUPER_SIZE
  }

  const headerLen = HEADER_FIXED_SIZE + regions.length * REGION_SIZE
  const header = Buffer.alloc(headerLen)
  header.write(BLOCK_MAP_V3_MAGIC, 0, 4, "latin1")
  header.writeUInt8(BLOCK_MAP_V3_VERSION, 4)
  header.writeUInt8(HASH_LEN, 5)
  header.writeUInt8(HASH_LEN, 6)
  header.writeUInt8(0, 7)
  header.writeBigUInt64LE(BigInt(options.fileSize), 8)
  header.writeUInt32LE(groups.length, 16)
  header.writeUInt32LE(blocks.length, 20)
  header.writeUInt32LE(headerLen, 24)
  header.writeUInt32LE(options.defaultChunker.min, 28)
  header.writeUInt32LE(options.defaultChunker.avg, 32)
  header.writeUInt32LE(options.defaultChunker.max, 36)
  header.writeUInt16LE(regions.length, 40)
  header.writeUInt32LE(supers.length, 42)
  let p = HEADER_FIXED_SIZE
  for (const region of regions) {
    header.writeBigUInt64LE(BigInt(region.offset), p)
    header.writeBigUInt64LE(BigInt(region.size), p + 8)
    header.writeUInt32LE(region.min, p + 16)
    header.writeUInt32LE(region.avg, p + 20)
    header.writeUInt32LE(region.max, p + 24)
    p += REGION_SIZE
  }
  return Buffer.concat([header, superBytes, groupBytes, recordBytes])
}

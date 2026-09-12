import { blake2b } from "@noble/hashes/blake2.js"
import { BlockMap } from "./blockMapApi.js"

/**
 * Block map v3 — a range-fetchable, two-level binary block map (see the v3 spec in the PR that
 * introduced it). Little-endian, uncompressed, fixed-size tables, so an updater can fetch the header
 * and group table with one Range request, compare group hashes against its cached previous map, and
 * fetch only the records of groups that changed.
 *
 *   header  (HEADER_FIXED_SIZE + regionCount × REGION_SIZE bytes)
 *   groups  (groupCount × GROUP_SIZE): { groupHash u64, byteLength u32, blockCount u16, reserved u16 }
 *   records (blockCount × RECORD_SIZE): { blockHash u64, size u16 }
 *
 * A block hash is the first 8 bytes of the blake2b-18 digest that v2 base64-encodes; a group hash is
 * the first 8 bytes of blake2b-18 over the group's concatenated records. Groups are content-defined on
 * the block-hash stream (a group ends when the low GROUP_MASK bits of a block hash are all set, subject
 * to GROUP_MIN/GROUP_MAX blocks) and forced closed at every region edge and at EOF, so an unchanged run
 * of blocks yields identical groups wherever it sits.
 */

export const BLOCK_MAP_V3_MAGIC = "EBM3"
export const BLOCK_MAP_V3_VERSION = 1
export const BLOCK_MAP_V3_FILE_SUFFIX = ".blockmap3"

export const HASH_LEN = 8
export const GROUP_SIZE = 16
export const RECORD_SIZE = 10
export const REGION_SIZE = 28
export const HEADER_FIXED_SIZE = 42

/** Content-defined grouping parameters (in blocks). */
export const GROUP_AVG = 64
export const GROUP_MASK = GROUP_AVG - 1
export const GROUP_MIN = 16
export const GROUP_MAX = 256

export interface ChunkerParamsV3 {
  min: number
  avg: number
  max: number
}

export interface BlockMapV3Region extends ChunkerParamsV3 {
  offset: number
  size: number
}

export interface BlockMapV3Group {
  /** 8-byte hash as a 16-char lowercase hex string (avoids BigInt in hot paths) */
  hash: string
  byteLength: number
  blockCount: number
}

export interface BlockMapV3Record {
  /** 8-byte hash as a 16-char lowercase hex string */
  hash: string
  size: number
}

export interface BlockMapV3Header {
  version: number
  fileSize: number
  groupCount: number
  blockCount: number
  /** byte offset of the group table */
  headerLen: number
  defaultChunker: ChunkerParamsV3
  regions: Array<BlockMapV3Region>
}

export interface BlockMapV3 {
  header: BlockMapV3Header
  groups: Array<BlockMapV3Group>
  /** records of every block, in file order */
  records: Array<BlockMapV3Record>
}

/** Input block for the encoder: the full blake2b-18 digest (or at least its first 8 bytes) and the block size. */
export interface BlockInput {
  digest: Uint8Array
  size: number
  /** absolute offset of the block's first byte; used only to force group boundaries at region edges */
  offset: number
}

function hex8(bytes: Uint8Array, start = 0): string {
  let s = ""
  for (let i = start; i < start + HASH_LEN; i++) {
    s += bytes[i].toString(16).padStart(2, "0")
  }
  return s
}

function writeHex8(buf: Buffer, offset: number, hex: string): void {
  buf.write(hex, offset, HASH_LEN, "hex")
}

export function groupHashOfRecords(recordBytes: Uint8Array): string {
  return hex8(blake2b(recordBytes, { dkLen: 18 }))
}

/**
 * Splits `blocks` (in file order) into content-defined groups. Boundaries are forced at every offset
 * in `forcedBoundaries` (region edges) and at the end.
 */
export function groupBlocks(blocks: Array<BlockInput>, forcedBoundaries: Set<number> = new Set()): Array<{ start: number; end: number }> {
  const groups: Array<{ start: number; end: number }> = []
  let start = 0
  for (let i = 0; i < blocks.length; i++) {
    const count = i - start + 1
    const next = blocks[i + 1]
    const forced = next == null || forcedBoundaries.has(next.offset)
    // low 6 bits of the last hash byte(s): use the last byte of the 8-byte hash for the mask test
    const marker = (blocks[i].digest[HASH_LEN - 1] & GROUP_MASK) === GROUP_MASK
    if (forced || count >= GROUP_MAX || (count >= GROUP_MIN && marker)) {
      groups.push({ start, end: i + 1 })
      start = i + 1
    }
  }
  return groups
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
  const headerLen = HEADER_FIXED_SIZE + regions.length * REGION_SIZE
  const buf = Buffer.alloc(headerLen + groups.length * GROUP_SIZE + blocks.length * RECORD_SIZE)

  buf.write(BLOCK_MAP_V3_MAGIC, 0, 4, "latin1")
  buf.writeUInt8(BLOCK_MAP_V3_VERSION, 4)
  buf.writeUInt8(HASH_LEN, 5)
  buf.writeUInt8(HASH_LEN, 6)
  buf.writeUInt8(0, 7)
  buf.writeBigUInt64LE(BigInt(options.fileSize), 8)
  buf.writeUInt32LE(groups.length, 16)
  buf.writeUInt32LE(blocks.length, 20)
  buf.writeUInt32LE(headerLen, 24)
  buf.writeUInt32LE(options.defaultChunker.min, 28)
  buf.writeUInt32LE(options.defaultChunker.avg, 32)
  buf.writeUInt32LE(options.defaultChunker.max, 36)
  buf.writeUInt16LE(regions.length, 40)
  let p = HEADER_FIXED_SIZE
  for (const region of regions) {
    buf.writeBigUInt64LE(BigInt(region.offset), p)
    buf.writeBigUInt64LE(BigInt(region.size), p + 8)
    buf.writeUInt32LE(region.min, p + 16)
    buf.writeUInt32LE(region.avg, p + 20)
    buf.writeUInt32LE(region.max, p + 24)
    p += REGION_SIZE
  }

  const recordsStart = headerLen + groups.length * GROUP_SIZE
  let r = recordsStart
  for (const block of blocks) {
    if (block.size > 0xffff) {
      throw new Error(`block map v3: block size ${block.size} exceeds the 16-bit record limit`)
    }
    buf.set(block.digest.subarray(0, HASH_LEN), r)
    buf.writeUInt16LE(block.size, r + HASH_LEN)
    r += RECORD_SIZE
  }

  let g = headerLen
  for (const group of groups) {
    let byteLength = 0
    for (let i = group.start; i < group.end; i++) {
      byteLength += blocks[i].size
    }
    const recordBytes = buf.subarray(recordsStart + group.start * RECORD_SIZE, recordsStart + group.end * RECORD_SIZE)
    writeHex8(buf, g, groupHashOfRecords(recordBytes))
    buf.writeUInt32LE(byteLength, g + 8)
    buf.writeUInt16LE(group.end - group.start, g + 12)
    buf.writeUInt16LE(0, g + 14)
    g += GROUP_SIZE
  }
  return buf
}

/** Parses the fixed header + regions. `buf` must hold at least HEADER_FIXED_SIZE bytes (and the regions). */
export function parseBlockMapV3Header(buf: Buffer): BlockMapV3Header {
  if (buf.length < HEADER_FIXED_SIZE || buf.toString("latin1", 0, 4) !== BLOCK_MAP_V3_MAGIC) {
    throw new Error("block map v3: bad magic")
  }
  const version = buf.readUInt8(4)
  if (version !== BLOCK_MAP_V3_VERSION) {
    throw new Error(`block map v3: unsupported version ${version}`)
  }
  if (buf.readUInt8(5) !== HASH_LEN || buf.readUInt8(6) !== HASH_LEN) {
    throw new Error("block map v3: unsupported hash length")
  }
  const regionCount = buf.readUInt16LE(40)
  const headerLen = buf.readUInt32LE(24)
  if (headerLen !== HEADER_FIXED_SIZE + regionCount * REGION_SIZE) {
    throw new Error("block map v3: inconsistent header length")
  }
  if (buf.length < headerLen) {
    throw new Error("block map v3: truncated header")
  }
  const regions: Array<BlockMapV3Region> = []
  let p = HEADER_FIXED_SIZE
  for (let i = 0; i < regionCount; i++) {
    regions.push({
      offset: Number(buf.readBigUInt64LE(p)),
      size: Number(buf.readBigUInt64LE(p + 8)),
      min: buf.readUInt32LE(p + 16),
      avg: buf.readUInt32LE(p + 20),
      max: buf.readUInt32LE(p + 24),
    })
    p += REGION_SIZE
  }
  return {
    version,
    fileSize: Number(buf.readBigUInt64LE(8)),
    groupCount: buf.readUInt32LE(16),
    blockCount: buf.readUInt32LE(20),
    headerLen,
    defaultChunker: { min: buf.readUInt32LE(28), avg: buf.readUInt32LE(32), max: buf.readUInt32LE(36) },
    regions,
  }
}

/** Parses the group table given the header and a buffer holding bytes [0, headerLen + groupCount*GROUP_SIZE). */
export function parseBlockMapV3Groups(header: BlockMapV3Header, buf: Buffer): Array<BlockMapV3Group> {
  const end = header.headerLen + header.groupCount * GROUP_SIZE
  if (buf.length < end) {
    throw new Error("block map v3: truncated group table")
  }
  const groups: Array<BlockMapV3Group> = []
  for (let g = header.headerLen; g < end; g += GROUP_SIZE) {
    groups.push({ hash: hex8(buf, g), byteLength: buf.readUInt32LE(g + 8), blockCount: buf.readUInt16LE(g + 12) })
  }
  return groups
}

/** Parses `count` records starting at byte `offset` of `buf` (a slice of the records table). */
export function parseBlockMapV3Records(buf: Buffer, offset: number, count: number): Array<BlockMapV3Record> {
  if (buf.length < offset + count * RECORD_SIZE) {
    throw new Error("block map v3: truncated records")
  }
  const records: Array<BlockMapV3Record> = []
  for (let i = 0, r = offset; i < count; i++, r += RECORD_SIZE) {
    records.push({ hash: hex8(buf, r), size: buf.readUInt16LE(r + HASH_LEN) })
  }
  return records
}

/** Byte range [start, end) of a group's records within the file, from cumulative block counts. */
export function recordRangeOfGroup(header: BlockMapV3Header, groups: Array<BlockMapV3Group>, index: number): { start: number; end: number } {
  let blocksBefore = 0
  for (let i = 0; i < index; i++) {
    blocksBefore += groups[i].blockCount
  }
  const start = header.headerLen + header.groupCount * GROUP_SIZE + blocksBefore * RECORD_SIZE
  return { start, end: start + groups[index].blockCount * RECORD_SIZE }
}

/** Parses a complete v3 buffer. */
export function decodeBlockMapV3(buf: Buffer): BlockMapV3 {
  const header = parseBlockMapV3Header(buf)
  const groups = parseBlockMapV3Groups(header, buf)
  const recordsStart = header.headerLen + header.groupCount * GROUP_SIZE
  const records = parseBlockMapV3Records(buf, recordsStart, header.blockCount)
  let counted = 0
  for (const group of groups) {
    counted += group.blockCount
  }
  if (counted !== header.blockCount) {
    throw new Error("block map v3: group block counts do not sum to blockCount")
  }
  return { header, groups, records }
}

/**
 * Converts a v3 map to the v2 `BlockMap` shape consumed by `computeOperations`. Checksums are the
 * 16-char hex block hashes (any unique string works for the planner; sizes drive the offsets).
 */
export function toBlockMap(map: BlockMapV3): BlockMap {
  return {
    version: "2",
    files: [{ name: "file", offset: 0, checksums: map.records.map(record => record.hash), sizes: map.records.map(record => record.size) }],
  }
}

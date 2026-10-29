import { blake2b } from "@noble/hashes/blake2.js"
import { BlockMap } from "./blockMapApi"

/**
 * Block map v3 reader — a range-fetchable, three-level binary block map, as published by electron-builder 27 with
 * `blockmap: "v3"`. This module only reads the format; electron-builder 26 keeps writing the gzipped JSON block map.
 *
 * Little-endian, uncompressed, fixed-size tables, so an updater can fetch the header and the small super-group table with
 * one Range request, compare super hashes against its cached previous map, fetch only the group entries of super-groups that
 * changed, compare those, and finally fetch only the records of the groups that changed.
 *
 *   header  (HEADER_FIXED_SIZE + regionCount × REGION_SIZE bytes)
 *   supers  (superCount × SUPER_SIZE):  { superHash u64, blockCount u32, groupCount u16, reserved u16 }
 *   groups  (groupCount × GROUP_SIZE):  { groupHash u64, byteLength u32, blockCount u16, reserved u16 }
 *   records (blockCount × RECORD_SIZE): { blockHash u64, size u16 }
 *
 * A block hash is the first 8 bytes of the blake2b-18 digest that v2 base64-encodes; a group hash is the first 8 bytes of
 * blake2b-18 over the group's concatenated records; a super hash is the same over the super-group's concatenated group entries.
 */

export const BLOCK_MAP_V3_MAGIC = "EBB3"
export const BLOCK_MAP_V3_VERSION = 2

/**
 * Whether `data` is a block map in the binary, range-fetchable format (the `blockmap: "v3"` format) rather than the gzipped JSON
 * block map (`"v2"`). Both are published as `<file>.blockmap`; the first bytes tell them apart.
 */
export function isBlockMapV3(data: Buffer): boolean {
  return data.length >= BLOCK_MAP_V3_MAGIC.length && data.toString("latin1", 0, BLOCK_MAP_V3_MAGIC.length) === BLOCK_MAP_V3_MAGIC
}

export const HASH_LEN = 8
export const SUPER_SIZE = 16
export const GROUP_SIZE = 16
export const RECORD_SIZE = 10
export const REGION_SIZE = 28
export const HEADER_FIXED_SIZE = 46

export interface ChunkerParamsV3 {
  min: number
  avg: number
  max: number
}

export interface BlockMapV3Region extends ChunkerParamsV3 {
  offset: number
  size: number
}

export interface BlockMapV3Super {
  /** 8-byte hash of the super-group's group entries as a 16-char lowercase hex string */
  hash: string
  blockCount: number
  groupCount: number
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
  superCount: number
  groupCount: number
  blockCount: number
  /** byte offset of the super-group table (the group table and the records follow it) */
  headerLen: number
  defaultChunker: ChunkerParamsV3
  regions: Array<BlockMapV3Region>
}

export interface BlockMapV3 {
  header: BlockMapV3Header
  supers: Array<BlockMapV3Super>
  groups: Array<BlockMapV3Group>
  /** records of every block, in file order */
  records: Array<BlockMapV3Record>
}

function hex8(bytes: Uint8Array, start = 0): string {
  let s = ""
  for (let i = start; i < start + HASH_LEN; i++) {
    s += bytes[i].toString(16).padStart(2, "0")
  }
  return s
}

export function groupHashOfRecords(recordBytes: Uint8Array): string {
  return hex8(blake2b(recordBytes, { dkLen: 18 }))
}

export function superHashOfGroups(groupBytes: Uint8Array): string {
  return hex8(blake2b(groupBytes, { dkLen: 18 }))
}

export interface IndexRange {
  start: number
  /** exclusive */
  end: number
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
  const fileSize = Number(buf.readBigUInt64LE(8))
  const superCount = buf.readUInt32LE(42)
  const groupCount = buf.readUInt32LE(16)
  const blockCount = buf.readUInt32LE(20)
  // every block, group and super-group is non-empty, so the counts are bounded by the file size; checked before any table
  // size derived from them is allocated or requested
  if (blockCount > fileSize || groupCount > blockCount || superCount > groupCount) {
    throw new Error(`block map v3: inconsistent counts (fileSize ${fileSize}, blocks ${blockCount}, groups ${groupCount}, super-groups ${superCount})`)
  }
  return {
    version,
    fileSize,
    superCount,
    groupCount,
    blockCount,
    headerLen,
    defaultChunker: { min: buf.readUInt32LE(28), avg: buf.readUInt32LE(32), max: buf.readUInt32LE(36) },
    regions,
  }
}

/** Byte offset of the group table. */
export function groupTableStart(header: BlockMapV3Header): number {
  return header.headerLen + header.superCount * SUPER_SIZE
}

/** Byte offset of the records. */
export function recordsStart(header: BlockMapV3Header): number {
  return groupTableStart(header) + header.groupCount * GROUP_SIZE
}

/** Total size of the map file described by `header`. */
export function blockMapV3Size(header: BlockMapV3Header): number {
  return recordsStart(header) + header.blockCount * RECORD_SIZE
}

/** Parses the super-group table given the header and a buffer holding bytes [0, groupTableStart). */
export function parseBlockMapV3Supers(header: BlockMapV3Header, buf: Buffer): Array<BlockMapV3Super> {
  const end = groupTableStart(header)
  if (buf.length < end) {
    throw new Error("block map v3: truncated super-group table")
  }
  const supers: Array<BlockMapV3Super> = []
  for (let s = header.headerLen; s < end; s += SUPER_SIZE) {
    supers.push({ hash: hex8(buf, s), blockCount: buf.readUInt32LE(s + 8), groupCount: buf.readUInt16LE(s + 12) })
  }
  return supers
}

/** Parses the group table given the header and a buffer holding bytes [0, recordsStart). */
export function parseBlockMapV3Groups(header: BlockMapV3Header, buf: Buffer): Array<BlockMapV3Group> {
  const start = groupTableStart(header)
  const end = recordsStart(header)
  if (buf.length < end) {
    throw new Error("block map v3: truncated group table")
  }
  const groups: Array<BlockMapV3Group> = []
  for (let g = start; g < end; g += GROUP_SIZE) {
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

/** Byte ranges [start, end) of every super-group's group entries within the file (cumulative, O(n)). */
export function groupEntryRanges(header: BlockMapV3Header, supers: Array<BlockMapV3Super>): Array<IndexRange> {
  const result: Array<IndexRange> = []
  let start = groupTableStart(header)
  for (const sup of supers) {
    const end = start + sup.groupCount * GROUP_SIZE
    result.push({ start, end })
    start = end
  }
  return result
}

/** Byte ranges [start, end) of every group's records within the file (cumulative, O(n)). */
export function recordRanges(header: BlockMapV3Header, groups: Array<BlockMapV3Group>): Array<IndexRange> {
  const result: Array<IndexRange> = []
  let start = recordsStart(header)
  for (const group of groups) {
    const end = start + group.blockCount * RECORD_SIZE
    result.push({ start, end })
    start = end
  }
  return result
}

/** Byte range [start, end) of a group's records within the file. */
export function recordRangeOfGroup(header: BlockMapV3Header, groups: Array<BlockMapV3Group>, index: number): IndexRange {
  return recordRanges(header, groups)[index]
}

/** Parses a complete v3 buffer. */
export function decodeBlockMapV3(buf: Buffer): BlockMapV3 {
  const header = parseBlockMapV3Header(buf)
  const supers = parseBlockMapV3Supers(header, buf)
  const groups = parseBlockMapV3Groups(header, buf)
  const records = parseBlockMapV3Records(buf, recordsStart(header), header.blockCount)
  let groupsCounted = 0
  let blocksCounted = 0
  for (const sup of supers) {
    if (sup.groupCount === 0) {
      throw new Error("block map v3: empty super-group")
    }
    groupsCounted += sup.groupCount
    blocksCounted += sup.blockCount
  }
  if (groupsCounted !== header.groupCount || blocksCounted !== header.blockCount) {
    throw new Error("block map v3: super-group counts do not sum to groupCount/blockCount")
  }
  let counted = 0
  for (const group of groups) {
    if (group.blockCount === 0) {
      throw new Error("block map v3: empty group")
    }
    counted += group.blockCount
  }
  if (counted !== header.blockCount) {
    throw new Error("block map v3: group block counts do not sum to blockCount")
  }
  if (records.some(record => record.size === 0)) {
    throw new Error("block map v3: empty block")
  }
  return { header, supers, groups, records }
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

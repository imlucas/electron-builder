import { blake2b } from "@noble/hashes/blake2.js"
import { BlockInput, CancellationToken, decodeBlockMapV3, encodeBlockMapV3, GROUP_SIZE, RECORD_SIZE } from "builder-util-runtime"
import {
  coalesce,
  fetchBlockMapV3,
  FIRST_RANGE_SIZE,
  firstRangeSize,
  MIN_FIRST_RANGE_SIZE,
  parseMultipartByteRanges,
} from "electron-updater/src/differentialDownloader/blockMapV3Fetcher"
import * as http from "http"
import { AddressInfo } from "net"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { httpExecutor } from "../helpers/updaterTestUtil"

// Deterministic synthetic blocks: content-derived digests, sizes around a mean (same generator as blockMapV3Test).
function makeBlocks(count: number, seed: number, avgSize = 4096, startOffset = 0): Array<BlockInput> {
  const blocks: Array<BlockInput> = []
  let x = seed >>> 0
  let offset = startOffset
  for (let i = 0; i < count; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    const size = Math.max(64, Math.min(0xffff, avgSize + ((x % (avgSize * 2)) - avgSize) / 2))
    const digest = blake2b(Buffer.from(`block-${seed}-${i}-${x}`), { dkLen: 18 })
    blocks.push({ digest, size: Math.floor(size), offset })
    offset += Math.floor(size)
  }
  return blocks
}

function encode(blocks: Array<BlockInput>): Buffer {
  const fileSize = blocks.reduce((sum, b) => sum + b.size, 0)
  return encodeBlockMapV3(blocks, { fileSize, defaultChunker: { min: 8192, avg: 16384, max: 32768 } })
}

/** Re-offsets blocks after an edit so the group boundary logic sees a consistent stream. */
function reoffset(blocks: Array<BlockInput>): Array<BlockInput> {
  let offset = 0
  return blocks.map(b => {
    const result = { ...b, offset }
    offset += b.size
    return result
  })
}

interface RequestLog {
  method: string
  range: string | null
  status: number
}

interface TestServer {
  url: URL
  requests: Array<RequestLog>
  rangeSupport: boolean
  files: Map<string, Buffer>
  close(): Promise<void>
}

function parseRanges(header: string, size: number): Array<[number, number]> | null {
  const m = /^bytes=(.+)$/.exec(header)
  if (m == null) {
    return null
  }
  const ranges: Array<[number, number]> = []
  for (const r of m[1].split(",")) {
    const [s, e] = r.trim().split("-")
    const start = s === "" ? size - parseInt(e, 10) : parseInt(s, 10)
    const end = e === "" ? size - 1 : Math.min(parseInt(e, 10), size - 1)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) {
      return null
    }
    ranges.push([start, end])
  }
  return ranges
}

/** In-memory file server with single- and multi-range support (206 + Content-Range, 416 when unsatisfiable) and a switch to disable Range support. */
function startServer(): Promise<TestServer> {
  const state: TestServer = { url: null as any, requests: [], rangeSupport: true, files: new Map(), close: null as any }
  const server = http.createServer((req, res) => {
    const name = new URL(req.url!, "http://localhost").pathname.replace(/^\/+/, "")
    const file = state.files.get(name)
    const rangeHeader = req.headers["range"] ?? null
    const log: RequestLog = { method: req.method!, range: rangeHeader, status: 0 }
    state.requests.push(log)
    const send = (status: number, headers: http.OutgoingHttpHeaders, body?: Buffer) => {
      log.status = status
      res.writeHead(status, headers)
      res.end(body)
    }
    if (file == null) {
      send(404, {}, Buffer.from("Not found"))
      return
    }
    if (rangeHeader == null || !state.rangeSupport) {
      send(200, { "Content-Length": file.length, "Content-Type": "application/octet-stream", ...(state.rangeSupport ? { "Accept-Ranges": "bytes" } : {}) }, file)
      return
    }
    const ranges = parseRanges(rangeHeader, file.length)
    if (ranges == null) {
      send(416, { "Content-Range": `bytes */${file.length}` })
      return
    }
    if (ranges.length === 1) {
      const [start, end] = ranges[0]
      send(206, { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Type": "application/octet-stream" }, file.subarray(start, end + 1))
      return
    }
    const boundary = "gc0p4Jq0M2Yt08jU534c0p"
    const parts: Array<Buffer> = []
    ranges.forEach(([start, end], i) => {
      parts.push(Buffer.from(`${i === 0 ? "" : "\r\n"}--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${start}-${end}/${file.length}\r\n\r\n`))
      parts.push(file.subarray(start, end + 1))
    })
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    send(206, { "Accept-Ranges": "bytes", "Content-Type": `multipart/byteranges; boundary=${boundary}` }, Buffer.concat(parts))
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      state.url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
      state.close = () => new Promise<void>(r => server.close(() => r()))
      resolve(state)
    })
  })
}

describe("blockMapV3Fetcher", () => {
  let server: TestServer
  beforeAll(async () => {
    server = await startServer()
  })
  afterAll(async () => {
    await server.close()
  })

  // ~200 groups: 200 × 64 blocks on average
  const OLD_BLOCKS = makeBlocks(200 * 64, 1)
  const OLD = encode(OLD_BLOCKS)
  const oldMap = decodeBlockMapV3(OLD)

  function fetchWith(name: string, old: Buffer | null, isUseMultipleRangeRequest?: boolean) {
    server.requests.length = 0
    return fetchBlockMapV3({
      url: new URL(name, server.url),
      oldMap: old,
      httpExecutor,
      cancellationToken: new CancellationToken(),
      isUseMultipleRangeRequest,
    })
  }

  /** first block index of group `groupIndex` */
  function firstBlockOf(groupIndex: number): number {
    let blockIndex = 0
    for (let i = 0; i < groupIndex; i++) {
      blockIndex += oldMap.groups[i].blockCount
    }
    return blockIndex
  }

  function edit(blocks: Array<BlockInput>, blockIndex: number, tag: string) {
    blocks[blockIndex] = { ...blocks[blockIndex], digest: blake2b(Buffer.from(`${tag}-${blockIndex}`), { dkLen: 18 }) }
  }

  test("map fixture has ~200 groups and does not fit into the first range", () => {
    expect(oldMap.groups.length).toBeGreaterThan(150)
    expect(oldMap.groups.length).toBeLessThan(260)
    expect(OLD.length).toBeGreaterThan(FIRST_RANGE_SIZE)
    // the first range is sized from the old group table: covers it with margin, far from the whole map
    const first = firstRangeSize(oldMap.header)
    expect(first).toBeGreaterThan(oldMap.header.headerLen + oldMap.groups.length * GROUP_SIZE)
    expect(first).toBeLessThan(OLD.length / 10)
    expect(firstRangeSize({ ...oldMap.header, groupCount: 1 })).toBe(MIN_FIRST_RANGE_SIZE)
    expect(firstRangeSize({ ...oldMap.header, groupCount: 100000 })).toBe(FIRST_RANGE_SIZE)
  })

  test("no old map → one plain GET of the whole file", async () => {
    server.files.set("new.blockmap3", OLD)
    const result = await fetchWith("new.blockmap3", null)
    expect(result.buffer.equals(OLD)).toBe(true)
    expect(result.requests).toBe(1)
    expect(result.wireBytes).toBe(OLD.length)
    expect(server.requests).toEqual([{ method: "GET", range: null, status: 200 }])
    expect(result.matchedGroups).toBe(0)
    expect(result.fetchedGroups).toBe(oldMap.groups.length)
  })

  test("old map sharing most groups → byte-identical reconstruction with wireBytes < 25 % of the file (3-group change)", async () => {
    // change one block in each of three groups spread over the map
    const blocks = OLD_BLOCKS.map(b => ({ ...b }))
    for (const groupIndex of [20, 100, oldMap.groups.length - 20]) {
      // the second block of a group can never be a group boundary (GROUP_MIN), so the grouping stays put
      edit(blocks, firstBlockOf(groupIndex) + 1, "edited")
    }
    const NEW = encode(reoffset(blocks))
    const newMap = decodeBlockMapV3(NEW)
    server.files.set("new.blockmap3", NEW)

    const result = await fetchWith("new.blockmap3", OLD, false)
    expect(result.buffer.equals(NEW)).toBe(true)
    expect(result.fetchedGroups).toBe(3)
    expect(result.matchedGroups).toBe(newMap.groups.length - 3)
    // header + group table (first range) + 3 groups' records
    const groupTable = newMap.header.headerLen + newMap.groups.length * GROUP_SIZE
    expect(result.wireBytes).toBeLessThan(NEW.length * 0.25)
    expect(result.wireBytes).toBeGreaterThanOrEqual(groupTable)
    // single-range host: 1 (header + group table) + 3 record ranges
    expect(result.requests).toBe(4)
    expect(server.requests.every(it => it.status === 206)).toBe(true)
    console.log(
      `blockMapV3Fetcher: partial fetch ${result.wireBytes} of ${NEW.length} bytes (${((100 * result.wireBytes) / NEW.length).toFixed(1)} %) in ${result.requests} requests`
    )
    expect(server.requests[0].range).toBe(`bytes=0-${firstRangeSize(oldMap.header) - 1}`)
  })

  test("multipart host: unmatched groups fetched in one multipart/byteranges request", async () => {
    const blocks = OLD_BLOCKS.map(b => ({ ...b }))
    for (const groupIndex of [30, 90, 150]) {
      edit(blocks, firstBlockOf(groupIndex) + 1, "multipart")
    }
    const NEW = encode(reoffset(blocks))
    server.files.set("new.blockmap3", NEW)

    const result = await fetchWith("new.blockmap3", OLD, true)
    expect(result.buffer.equals(NEW)).toBe(true)
    expect(result.fetchedGroups).toBe(3)
    expect(result.requests).toBe(2)
    expect(server.requests[1].range!.split(",").length).toBe(3)
    expect(result.wireBytes).toBeLessThan(NEW.length * 0.25)
  })

  test("adjacent unmatched groups are coalesced into one request", async () => {
    // edit one block in each of four consecutive groups
    const blocks = OLD_BLOCKS.map(b => ({ ...b }))
    for (let g = 50; g < 54; g++) {
      edit(blocks, firstBlockOf(g) + 1, "adjacent")
    }
    const NEW = encode(reoffset(blocks))
    server.files.set("new.blockmap3", NEW)

    const result = await fetchWith("new.blockmap3", OLD, false)
    expect(result.buffer.equals(NEW)).toBe(true)
    expect(result.fetchedGroups).toBe(4)
    // header/group table + exactly one coalesced record range
    expect(result.requests).toBe(2)
    const rangeRequests = server.requests.filter(it => it.range != null)
    expect(rangeRequests.length).toBe(2)
    expect(rangeRequests[1].range!.includes(",")).toBe(false)
  })

  test("server without Range support → whole file from the (ignored) Range request, no extra GET", async () => {
    server.files.set("new.blockmap3", OLD)
    server.rangeSupport = false
    try {
      const result = await fetchWith("new.blockmap3", OLD, false)
      expect(result.buffer.equals(OLD)).toBe(true)
      expect(result.requests).toBe(1)
      expect(result.wireBytes).toBe(OLD.length)
      expect(server.requests[0].status).toBe(200)
    } finally {
      server.rangeSupport = true
    }
  })

  test("small map fits into the first range → one request, no record fetch", async () => {
    const small = encode(makeBlocks(300, 5))
    expect(small.length).toBeLessThan(FIRST_RANGE_SIZE)
    server.files.set("small.blockmap3", small)
    const result = await fetchWith("small.blockmap3", OLD, false)
    expect(result.buffer.equals(small)).toBe(true)
    expect(result.requests).toBe(1)
  })

  test("corrupted header → throws (AppUpdater falls back to v2)", async () => {
    const corrupt = Buffer.from(OLD)
    corrupt.write("XXXX", 0, 4, "latin1")
    server.files.set("corrupt.blockmap3", corrupt)
    await expect(fetchWith("corrupt.blockmap3", OLD, false)).rejects.toThrow(/bad magic/)
    await expect(fetchWith("corrupt.blockmap3", null, false)).rejects.toThrow(/bad magic/)
  })

  test("corrupted records (group hash mismatch) → throws", async () => {
    // full download path: verification catches a flipped byte in the last record
    const corrupt = Buffer.from(OLD)
    corrupt[corrupt.length - RECORD_SIZE] ^= 0xff
    server.files.set("corrupt.blockmap3", corrupt)
    await expect(fetchWith("corrupt.blockmap3", null, false)).rejects.toThrow(/hash mismatch/)

    // partial path: the last group is unmatched (its second block changed) and its records come from the server, corrupted there
    const blocks = OLD_BLOCKS.map(b => ({ ...b }))
    edit(blocks, firstBlockOf(oldMap.groups.length - 1) + 1, "last")
    const corruptNew = encode(reoffset(blocks))
    corruptNew[corruptNew.length - RECORD_SIZE] ^= 0xff
    server.files.set("corrupt.blockmap3", corruptNew)
    await expect(fetchWith("corrupt.blockmap3", OLD, false)).rejects.toThrow(/hash mismatch/)

    // a matched group's records come from the old map, so corruption there is never fetched and the result is the valid map
    server.files.set("corrupt.blockmap3", corrupt)
    const result = await fetchWith("corrupt.blockmap3", OLD, false)
    expect(result.buffer.equals(OLD)).toBe(true)
  })

  test("404 → throws", async () => {
    await expect(fetchWith("missing.blockmap3", OLD, false)).rejects.toThrow(/404/)
    await expect(fetchWith("missing.blockmap3", null, false)).rejects.toThrow(/404/)
  })

  test("coalesce merges adjacent and near ranges only", () => {
    expect(
      coalesce(
        [
          { start: 0, end: 10 },
          { start: 10, end: 20 },
          { start: 25, end: 30 },
          { start: 5000, end: 5010 },
        ],
        8
      )
    ).toEqual([
      { start: 0, end: 30 },
      { start: 5000, end: 5010 },
    ])
  })

  test("parseMultipartByteRanges locates parts by Content-Range", () => {
    const boundary = "b"
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Range: bytes 10-12/100\r\n\r\n`),
      Buffer.from("abc"),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: x\r\nContent-Range: bytes 50-50/100\r\n\r\n`),
      Buffer.from("z"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const parts = parseMultipartByteRanges(body, boundary)
    expect(parts.map(it => [it.start, it.end, it.data.toString()])).toEqual([
      [10, 13, "abc"],
      [50, 51, "z"],
    ])
  })
})

import {
  BlockMapV3Group,
  BlockMapV3Header,
  CancellationToken,
  configureRequestOptions,
  configureRequestUrl,
  createHttpError,
  decodeBlockMapV3,
  GROUP_SIZE,
  groupHashOfRecords,
  HttpExecutor,
  parseBlockMapV3Groups,
  parseBlockMapV3Header,
  parseBlockMapV3Records,
  RECORD_SIZE,
  safeGetHeader,
} from "builder-util-runtime"
import { IncomingMessage, OutgoingHttpHeaders, RequestOptions } from "http"
import { URL } from "url"
import { Logger } from "../types.js"

/** Upper bound of the first Range request: header + group table of maps up to ~4k groups (≈ 4 GB of 16 KiB × 64 blocks). */
export const FIRST_RANGE_SIZE = 64 * 1024
/** Lower bound of the first Range request. */
export const MIN_FIRST_RANGE_SIZE = 4 * 1024
/** Unmatched record ranges separated by a gap up to this size are fetched as one range (a request costs ~1 KB of headers + 1 RTT). */
export const COALESCE_GAP_BYTES = 1024
/** Apache's default MaxRanges is 200 and header buffers are 8 KB; stay under both. */
export const MAX_RANGES_PER_REQUEST = 200
const MAX_REDIRECTS = 10

export interface BlockMapV3FetchOptions {
  /** URL of the NEW `.blockmap3` */
  readonly url: URL
  /** the cached OLD v3 map (complete file), or null when there is none — then the whole new map is downloaded with a plain GET */
  readonly oldMap: Buffer | null
  readonly httpExecutor: HttpExecutor<any>
  readonly requestHeaders?: OutgoingHttpHeaders | null
  readonly cancellationToken: CancellationToken
  /** same decision as the installer download (`Provider.isUseMultipleRangeRequest`) */
  readonly isUseMultipleRangeRequest?: boolean
  readonly logger?: Logger | null
}

export interface BlockMapV3FetchResult {
  /** the complete NEW v3 map, byte-identical to the remote file */
  readonly buffer: Buffer
  /** response body bytes received (headers excluded) */
  readonly wireBytes: number
  /** HTTP requests issued (redirects included) */
  readonly requests: number
  /** groups whose records were taken from the old map */
  readonly matchedGroups: number
  /** groups whose records were fetched */
  readonly fetchedGroups: number
}

interface ByteRange {
  start: number
  /** exclusive */
  end: number
}

interface RangeResponse {
  status: number
  body: Buffer
  contentType: string | null
  /** total size from `Content-Range: bytes a-b/size`, or null */
  totalSize: number | null
}

/**
 * Fetches the NEW v3 block map with minimal wire cost:
 * 1. Range-GET `[0, 64 KiB)` → header + group table (a second Range request if the group table is larger).
 * 2. Match new groups against the old map by (hash, byteLength, blockCount) → their records are copied from the old map.
 * 3. Range-fetch the records of unmatched groups (adjacent/near ranges coalesced; multipart requests of ≤ 200 ranges on hosts that support them).
 * 4. Assemble header + group table + records and verify every group hash before returning.
 *
 * Any HTTP error, 416, missing range support that cannot be recovered by a full GET, parse error or verification
 * mismatch throws — the caller (AppUpdater) falls back to the v2 path.
 */
export async function fetchBlockMapV3(options: BlockMapV3FetchOptions): Promise<BlockMapV3FetchResult> {
  const fetcher = new BlockMapV3Fetcher(options)
  return await fetcher.fetch()
}

class BlockMapV3Fetcher {
  private wireBytes = 0
  private requests = 0
  private readonly requestOptions: RequestOptions

  constructor(private readonly options: BlockMapV3FetchOptions) {
    const requestOptions: RequestOptions = {
      headers: {
        ...options.requestHeaders,
        accept: "*/*",
      },
    }
    configureRequestUrl(options.url, requestOptions)
    configureRequestOptions(requestOptions)
    ;(requestOptions as any).redirect = "manual"
    this.requestOptions = requestOptions
  }

  private result(buffer: Buffer, matchedGroups: number, fetchedGroups: number): BlockMapV3FetchResult {
    return { buffer, wireBytes: this.wireBytes, requests: this.requests, matchedGroups, fetchedGroups }
  }

  async fetch(): Promise<BlockMapV3FetchResult> {
    const oldMap = this.decodeOldMap()
    if (oldMap == null) {
      const buffer = await this.fetchWhole()
      const map = decodeBlockMapV3(buffer)
      verifyGroups(buffer, map.header, map.groups)
      return this.result(buffer, 0, map.groups.length)
    }

    // 1. header + group table
    const first = await this.rangeRequest([{ start: 0, end: firstRangeSize(oldMap.header) }], true)
    if (first.status === 200) {
      // server ignored Range — the body is the whole file
      return this.verifiedWhole(first.body, 0)
    }
    const header = parseBlockMapV3Header(first.body)
    const groupTableEnd = header.headerLen + header.groupCount * GROUP_SIZE
    const recordsEnd = groupTableEnd + header.blockCount * RECORD_SIZE
    if (first.totalSize != null && first.totalSize !== recordsEnd) {
      throw new Error(`block map v3: remote size ${first.totalSize} does not match header (expected ${recordsEnd})`)
    }

    let prefix = first.body
    if (prefix.length >= recordsEnd) {
      // the whole file fit into the first request
      return this.verifiedWhole(prefix.subarray(0, recordsEnd), 0)
    }
    if (prefix.length < groupTableEnd) {
      const rest = await this.rangeRequest([{ start: prefix.length, end: groupTableEnd }])
      if (rest.status === 200) {
        return this.verifiedWhole(rest.body, 0)
      }
      prefix = Buffer.concat([prefix, rest.body])
      if (prefix.length < groupTableEnd) {
        throw new Error("block map v3: truncated group table")
      }
    }
    const groups = parseBlockMapV3Groups(header, prefix)

    // 2. match groups against the old map
    const buffer = Buffer.alloc(recordsEnd)
    prefix.copy(buffer, 0, 0, groupTableEnd)
    // bytes of the prefix beyond the group table are valid record bytes too
    if (prefix.length > groupTableEnd) {
      prefix.copy(buffer, groupTableEnd, groupTableEnd, Math.min(prefix.length, recordsEnd))
    }
    const prefetched = Math.min(prefix.length, recordsEnd)

    const oldRecordRanges = recordRanges(oldMap.header, oldMap.groups)
    const oldByKey = new Map<string, ByteRange>()
    oldMap.groups.forEach((group, index) => oldByKey.set(groupKey(group), oldRecordRanges[index]))

    const newRecordRanges = recordRanges(header, groups)
    const missing: Array<ByteRange> = []
    let matchedGroups = 0
    groups.forEach((group, index) => {
      const range = newRecordRanges[index]
      const old = oldByKey.get(groupKey(group))
      if (old != null) {
        matchedGroups++
        this.options.oldMap!.copy(buffer, range.start, old.start, old.end)
      } else if (range.end > prefetched) {
        missing.push(range)
      }
    })

    // 3. fetch the records of unmatched groups
    const fetchedGroups = missing.length
    const ranges = coalesce(missing)
    if (ranges.length > 0) {
      const full = await this.fetchRanges(ranges, buffer)
      if (full != null) {
        return this.verifiedWhole(full, 0)
      }
    }

    // 4. verify
    verifyGroups(buffer, header, groups)
    this.options.logger?.info?.(
      `Block map v3: ${matchedGroups} of ${groups.length} groups reused from the old map, ${fetchedGroups} fetched in ${ranges.length} range(s); ${this.wireBytes} bytes / ${this.requests} request(s) for a ${recordsEnd}-byte map`
    )
    return this.result(buffer, matchedGroups, fetchedGroups)
  }

  private decodeOldMap() {
    const oldMap = this.options.oldMap
    if (oldMap == null || oldMap.length === 0) {
      return null
    }
    try {
      return decodeBlockMapV3(oldMap)
    } catch (e: any) {
      this.options.logger?.warn?.(`Cannot parse cached block map v3, downloading the whole new map: ${e.message || e}`)
      return null
    }
  }

  private verifiedWhole(body: Buffer, matchedGroups: number): BlockMapV3FetchResult {
    const map = decodeBlockMapV3(body)
    const expected = map.header.headerLen + map.header.groupCount * GROUP_SIZE + map.header.blockCount * RECORD_SIZE
    if (body.length !== expected) {
      throw new Error(`block map v3: file size ${body.length} does not match header (expected ${expected})`)
    }
    verifyGroups(body, map.header, map.groups)
    return this.result(body, matchedGroups, map.groups.length)
  }

  private async fetchWhole(): Promise<Buffer> {
    const response = await this.doRequest(null)
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`block map v3: unexpected status ${response.status} for a full download`)
    }
    if (response.body.length === 0) {
      throw new Error(`Blockmap "${this.options.url.href}" is empty`)
    }
    return response.body
  }

  /**
   * Fetches `ranges` into `target`. Returns the whole file if the server answered a Range request with 200 (no Range support), else null.
   */
  private async fetchRanges(ranges: Array<ByteRange>, target: Buffer): Promise<Buffer | null> {
    const useMultipart = this.options.isUseMultipleRangeRequest !== false
    if (!useMultipart || ranges.length === 1) {
      for (const range of ranges) {
        const response = await this.rangeRequest([range])
        if (response.status === 200) {
          return response.body
        }
        response.body.copy(target, range.start)
      }
      return null
    }

    for (let i = 0; i < ranges.length; i += MAX_RANGES_PER_REQUEST) {
      const batch = ranges.slice(i, i + MAX_RANGES_PER_REQUEST)
      const response = await this.rangeRequest(batch)
      if (response.status === 200) {
        return response.body
      }
      if (batch.length === 1) {
        response.body.copy(target, batch[0].start)
        continue
      }
      const contentType = response.contentType || ""
      const m = /^multipart\/.+?\s*;\s*boundary=(?:"([^"]+)"|([^\s";]+))\s*$/i.exec(contentType)
      if (m == null) {
        throw new Error(`Content-Type "multipart/byteranges" is expected, but got "${contentType}"`)
      }
      const parts = parseMultipartByteRanges(response.body, m[1] || m[2])
      const expected = new Map<number, number>(batch.map(it => [it.start, it.end]))
      for (const part of parts) {
        const end = expected.get(part.start)
        if (end == null || part.end !== end) {
          throw new Error(`block map v3: unexpected part ${part.start}-${part.end - 1} in a multipart response`)
        }
        part.data.copy(target, part.start)
        expected.delete(part.start)
      }
      if (expected.size !== 0) {
        throw new Error(`block map v3: multipart response is missing ${expected.size} of ${batch.length} requested ranges`)
      }
    }
    return null
  }

  /**
   * Issues one Range request. A 206 body of a single range must have the requested length, unless `allowShort`
   * (the first request, which may exceed a small file and is then answered with the file's tail).
   */
  private async rangeRequest(ranges: Array<ByteRange>, allowShort = false): Promise<RangeResponse> {
    const response = await this.doRequest(ranges)
    if (response.status === 206) {
      if (ranges.length === 1) {
        const requested = ranges[0].end - ranges[0].start
        const received = response.body.length
        if (received > requested || (received < requested && !allowShort)) {
          throw new Error(`Received data length ${received} is not equal to expected ${requested}`)
        }
      }
      return response
    }
    if (response.status === 200) {
      this.options.logger?.warn?.(`Server ignored the Range request for ${this.options.url.href}, downloaded the whole block map`)
      return response
    }
    throw new Error(`block map v3: unexpected status ${response.status} for a Range request`)
  }

  private doRequest(ranges: Array<ByteRange> | null, redirectCount = 0): Promise<RangeResponse> {
    const { cancellationToken, httpExecutor } = this.options
    return cancellationToken.createPromise<RangeResponse>((resolve, reject, onCancel) => {
      const requestOptions: RequestOptions = { ...this.requestOptions, headers: { ...this.requestOptions.headers } }
      if (ranges == null) {
        delete requestOptions.headers!.range
      } else {
        requestOptions.headers!.range = `bytes=${ranges.map(it => `${it.start}-${it.end - 1}`).join(", ")}`
      }
      this.requests++
      const request = httpExecutor.createRequest(requestOptions, (response: IncomingMessage) => {
        response.on("error", reject)
        response.on("aborted", () => reject(new Error("response has been aborted by the server")))

        const status = response.statusCode || 0
        // NodeJS executor: redirects arrive as responses (Electron's net emits the "redirect" event below instead)
        const location = safeGetHeader(response, "location")
        if (status >= 300 && status < 400 && location != null) {
          response.resume()
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error(`Too many redirects (> ${MAX_REDIRECTS})`))
            return
          }
          this.followRedirect(location)
          this.doRequest(ranges, redirectCount + 1).then(resolve, reject)
          return
        }
        if (status >= 400) {
          response.resume()
          reject(createHttpError(response))
          return
        }

        const chunks: Array<Buffer> = []
        response.on("data", (chunk: Buffer) => {
          this.wireBytes += chunk.length
          chunks.push(chunk)
        })
        response.on("end", () => {
          const contentRange = safeGetHeader(response, "content-range")
          const m = contentRange == null ? null : /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(contentRange)
          resolve({
            status,
            body: Buffer.concat(chunks),
            contentType: safeGetHeader(response, "content-type"),
            totalSize: m != null && m[3] !== "*" ? parseInt(m[3], 10) : null,
          })
        })
      })
      request.on("redirect", (_statusCode: number, _method: string, redirectUrl: string) => {
        this.followRedirect(redirectUrl)
        request.followRedirect()
      })
      httpExecutor.addErrorAndTimeoutHandlers(request, reject)
      onCancel(() => request.abort())
      request.end()
    })
  }

  private followRedirect(redirectUrl: string) {
    this.options.logger?.info?.(`Redirect to ${redirectUrl.replace(/\?.*$/, "")}`)
    // later ranges go directly to the redirected location (e.g. GitHub → CDN)
    configureRequestUrl(new URL(redirectUrl), this.requestOptions)
  }
}

/**
 * Size of the first Range request: enough for the header and a group table 25 % (+64 groups) larger than the old map's —
 * the new map is usually about the same size — clamped to [MIN_FIRST_RANGE_SIZE, FIRST_RANGE_SIZE]. Bytes beyond the
 * group table are record bytes and are used; if the group table is larger than guessed, its rest costs one more request.
 */
export function firstRangeSize(oldHeader: BlockMapV3Header): number {
  const estimate = oldHeader.headerLen + Math.ceil(oldHeader.groupCount * 1.25 + 64) * GROUP_SIZE
  return Math.min(FIRST_RANGE_SIZE, Math.max(MIN_FIRST_RANGE_SIZE, estimate))
}

function groupKey(group: BlockMapV3Group): string {
  return `${group.hash}:${group.byteLength}:${group.blockCount}`
}

/** Byte ranges of every group's records (cumulative, O(n) — `recordRangeOfGroup` per group would be O(n²)). */
function recordRanges(header: BlockMapV3Header, groups: Array<BlockMapV3Group>): Array<ByteRange> {
  const result: Array<ByteRange> = []
  let start = header.headerLen + header.groupCount * GROUP_SIZE
  for (const group of groups) {
    const end = start + group.blockCount * RECORD_SIZE
    result.push({ start, end })
    start = end
  }
  return result
}

/** Merges adjacent ranges and ranges separated by at most COALESCE_GAP_BYTES (ranges must be sorted and non-overlapping). */
export function coalesce(ranges: Array<ByteRange>, maxGap = COALESCE_GAP_BYTES): Array<ByteRange> {
  const result: Array<ByteRange> = []
  for (const range of ranges) {
    const last = result[result.length - 1]
    if (last != null && range.start - last.end <= maxGap) {
      last.end = Math.max(last.end, range.end)
    } else {
      result.push({ start: range.start, end: range.end })
    }
  }
  return result
}

/** Verifies that every group's records hash to its group hash and sum to its byteLength/blockCount, and that the map covers fileSize. */
function verifyGroups(buffer: Buffer, header: BlockMapV3Header, groups: Array<BlockMapV3Group>): void {
  if (groups.length !== header.groupCount) {
    throw new Error(`block map v3: group count ${groups.length} does not match header ${header.groupCount}`)
  }
  let offset = header.headerLen + header.groupCount * GROUP_SIZE
  let blocks = 0
  let bytes = 0
  groups.forEach((group, index) => {
    const end = offset + group.blockCount * RECORD_SIZE
    if (end > buffer.length) {
      throw new Error("block map v3: truncated records")
    }
    const recordBytes = buffer.subarray(offset, end)
    if (groupHashOfRecords(recordBytes) !== group.hash) {
      throw new Error(`block map v3: group ${index} hash mismatch`)
    }
    let byteLength = 0
    for (const record of parseBlockMapV3Records(recordBytes, 0, group.blockCount)) {
      byteLength += record.size
    }
    if (byteLength !== group.byteLength) {
      throw new Error(`block map v3: group ${index} byte length ${byteLength} does not match ${group.byteLength}`)
    }
    blocks += group.blockCount
    bytes += byteLength
    offset = end
  })
  if (blocks !== header.blockCount) {
    throw new Error("block map v3: group block counts do not sum to blockCount")
  }
  if (bytes !== header.fileSize) {
    throw new Error(`block map v3: blocks cover ${bytes} bytes, file size is ${header.fileSize}`)
  }
  if (offset !== buffer.length) {
    throw new Error(`block map v3: trailing ${buffer.length - offset} bytes`)
  }
}

interface MultipartPart {
  start: number
  /** exclusive */
  end: number
  data: Buffer
}

/** Parses a buffered `multipart/byteranges` body; parts are located by their Content-Range headers. */
export function parseMultipartByteRanges(body: Buffer, boundary: string): Array<MultipartPart> {
  const delimiter = Buffer.from(`--${boundary}`, "latin1")
  const parts: Array<MultipartPart> = []
  let position = body.indexOf(delimiter)
  while (position !== -1) {
    position += delimiter.length
    if (body[position] === 0x2d && body[position + 1] === 0x2d) {
      // closing delimiter "--boundary--"
      break
    }
    const headerEnd = body.indexOf("\r\n\r\n", position, "latin1")
    if (headerEnd === -1) {
      throw new Error("block map v3: malformed multipart part (no header terminator)")
    }
    const headers = body.toString("latin1", position, headerEnd)
    const m = /content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(headers)
    if (m == null) {
      throw new Error("block map v3: multipart part without Content-Range")
    }
    const start = parseInt(m[1], 10)
    const end = parseInt(m[2], 10) + 1
    const dataStart = headerEnd + 4
    const dataEnd = dataStart + (end - start)
    if (dataEnd > body.length) {
      throw new Error("block map v3: truncated multipart part")
    }
    parts.push({ start, end, data: body.subarray(dataStart, dataEnd) })
    position = body.indexOf(delimiter, dataEnd)
  }
  return parts
}

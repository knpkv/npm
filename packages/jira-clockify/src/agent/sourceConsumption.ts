/** Durable correlation between evidence blocks and entries written under a corrected ticket. */

export type Source = "clockify" | "jira"

export interface ConsumedSeconds {
  readonly clockify: number
  readonly jira: number
}

export type Consumption = Map<string, ConsumedSeconds>

export interface RecordedRow {
  readonly ticketKey?: string | undefined
  readonly day?: string | undefined
  readonly intervals: ReadonlyArray<{
    readonly entry?: {
      readonly source: Source
      readonly id: string
      readonly startMs: number
      readonly endMs: number
      readonly description: string | null
    } | undefined
  }>
}

/** Existing provider seconds overlapping one credited block, unioned and capped by its credit. */
export const recordedSecondsInBlock = (
  block: { readonly startMs: number; readonly endMs: number; readonly seconds: number },
  intervals: ReadonlyArray<{
    readonly startMs: number
    readonly endMs: number
    readonly source: Source
  }>,
  source: Source
): number => {
  const overlaps = intervals
    .filter((interval) => interval.source === source)
    .map((interval) => ({
      startMs: Math.max(block.startMs, interval.startMs),
      endMs: Math.min(block.endMs, interval.endMs)
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  let coveredMs = 0
  let endMs = Number.NEGATIVE_INFINITY
  for (const overlap of overlaps) {
    const startMs = Math.max(overlap.startMs, endMs)
    if (overlap.endMs > startMs) coveredMs += overlap.endMs - startMs
    endMs = Math.max(endMs, overlap.endMs)
  }
  return Math.min(block.seconds, coveredMs / 1000)
}

const sourceMarkerPattern = /\[jcf-source:([^\]]+)\]/g

/** Complete durable markers already present in a provider description. */
export const markers = (
  description: string
): ReadonlyArray<string> => [...new Set([...description.matchAll(sourceMarkerPattern)].map((match) => match[0]))]

/** Keep server-owned source markers stable while allowing the visible description to change. */
export const retainMarkers = (current: string, replacement: string): string => {
  const retained = markers(current)
  const submitted = markers(replacement)
  if (
    retained.length === submitted.length &&
    retained.every((value) => submitted.includes(value))
  ) return replacement

  const visible = replacement.replace(sourceMarkerPattern, "").trimEnd()
  return [visible, ...retained].filter((part) => part.length > 0).join("\n")
}

/** Stable key for one original row and source cluster. */
export const blockKey = (rowId: string, sourceStartMs: number): string => JSON.stringify([rowId, sourceStartMs])

/** Provider-visible correlation retained when a person changes the attributed ticket. */
export const marker = (rowId: string, sourceStartMs: number): string =>
  `[jcf-source:${encodeURIComponent(rowId)}:${String(sourceStartMs)}]`

const parsedMarker = (
  value: string
): { readonly key: string; readonly rowId: string; readonly sourceStartMs: number } | undefined => {
  const separator = value.lastIndexOf(":")
  if (separator < 0) return undefined
  const sourceStartMs = Number(value.slice(separator + 1))
  if (!Number.isFinite(sourceStartMs)) return undefined
  try {
    const rowId = decodeURIComponent(value.slice(0, separator))
    return { key: blockKey(rowId, sourceStartMs), rowId, sourceStartMs }
  } catch {
    return undefined
  }
}

/** Legacy migration hints only; descriptions never replace an existing provider-ID binding. */
export const sourceReferences = (description: string): ReadonlyArray<{
  readonly rowId: string
  readonly sourceStartMs: number
}> =>
  [...description.matchAll(sourceMarkerPattern)].flatMap((match) => {
    const parsed = match[1] === undefined ? undefined : parsedMarker(match[1])
    return parsed === undefined ? [] : [{ rowId: parsed.rowId, sourceStartMs: parsed.sourceStartMs }]
  })

interface MarkedEntry {
  readonly entryEndMs: number
  readonly entryStartMs: number
  readonly id: string
  readonly key: string
  readonly rowId: string
  readonly seconds: number
  readonly source: Source
  readonly sourceStartMs: number
}

/** Provider-ID-verified private projection; never serialized into a browser response. */
export interface ResolvedEntry {
  readonly source: Source
  readonly id: string
  readonly rowId: string
  readonly sourceStartMs: number
  readonly startMs: number
  readonly endMs: number
}

/** Marker-bearing provider entries, deduplicated across day slices and omitted from their source row. */
const markedEntries = (
  recorded: ReadonlyArray<RecordedRow>,
  resolved?: ReadonlyArray<ResolvedEntry>
): ReadonlyArray<MarkedEntry> => {
  const discovered: Array<MarkedEntry> = []
  const seen = new Set<string>()
  const byId = new Map((resolved ?? []).map((entry) => [`${entry.source}\u0000${entry.id}`, entry]))
  for (const row of recorded) {
    for (const interval of row.intervals) {
      const entry = interval.entry
      if (entry === undefined) continue
      const bound = byId.get(`${entry.source}\u0000${entry.id}`)
      if (bound !== undefined) {
        const key = blockKey(bound.rowId, bound.sourceStartMs)
        const seenKey = `${entry.source}\u0000${entry.id}\u0000${key}`
        if (!seen.has(seenKey) && `${row.day}:${row.ticketKey}` !== bound.rowId) {
          seen.add(seenKey)
          discovered.push({
            entryEndMs: bound.endMs,
            entryStartMs: bound.startMs,
            id: entry.id,
            key,
            rowId: bound.rowId,
            seconds: Math.max(0, (bound.endMs - bound.startMs) / 1000),
            source: entry.source,
            sourceStartMs: bound.sourceStartMs
          })
        }
        continue
      }
      // Once a private ledger was read, editable prose cannot create an unverified source link.
      if (resolved !== undefined) continue
      if (entry?.description === null || entry?.description === undefined) continue
      for (const match of entry.description.matchAll(sourceMarkerPattern)) {
        const parsed = match[1] === undefined ? undefined : parsedMarker(match[1])
        if (parsed === undefined || `${row.day}:${row.ticketKey}` === parsed.rowId) continue
        const seenKey = `${entry.source}\u0000${entry.id}\u0000${parsed.key}`
        if (seen.has(seenKey)) continue
        seen.add(seenKey)
        discovered.push({
          entryEndMs: entry.endMs,
          entryStartMs: entry.startMs,
          id: entry.id,
          key: parsed.key,
          rowId: parsed.rowId,
          seconds: Math.max(0, (entry.endMs - entry.startMs) / 1000),
          source: entry.source,
          sourceStartMs: parsed.sourceStartMs
        })
      }
    }
  }
  return discovered
}

/**
 * Assign marked entries to the current reconstruction of their source blocks.
 *
 * A watch window can clip a continuous source cluster, so its marker start is not necessarily the
 * start a later week read reconstructs. Prefer exact identity, then a block containing that marker,
 * then provider-time overlap. Each marker chooses one block so a long edited entry cannot consume
 * two genuinely separate stretches.
 */
export const consumptionForBlocks = (
  recorded: ReadonlyArray<RecordedRow>,
  rowId: string,
  blocks: ReadonlyArray<{
    readonly startMs: number
    readonly endMs: number
    readonly sourceStartMs?: number | undefined
  }>,
  sides: { readonly clockify: boolean; readonly jira: boolean } = { clockify: true, jira: true },
  resolved?: ReadonlyArray<ResolvedEntry>
): ReadonlyArray<ConsumedSeconds> => {
  const result = blocks.map((): ConsumedSeconds => ({ clockify: 0, jira: 0 }))
  for (const entry of markedEntries(recorded, resolved)) {
    if (entry.rowId !== rowId || !sides[entry.source]) continue
    let index = blocks.findIndex((block) => (block.sourceStartMs ?? block.startMs) === entry.sourceStartMs)
    if (index < 0) {
      index = blocks.findIndex((block) => {
        const sourceStartMs = block.sourceStartMs ?? block.startMs
        return entry.sourceStartMs >= sourceStartMs && entry.sourceStartMs < block.endMs
      })
    }
    if (index < 0) {
      let bestOverlap = 0
      for (const [candidate, block] of blocks.entries()) {
        const overlap = Math.max(
          0,
          Math.min(block.endMs, entry.entryEndMs) - Math.max(block.startMs, entry.entryStartMs)
        )
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          index = candidate
        }
      }
    }
    const current = result[index]
    if (index < 0 || current === undefined) continue
    result[index] = { ...current, [entry.source]: current[entry.source] + entry.seconds }
  }
  return result
}

/** Rebuild corrected-ticket consumption from provider entries, preserving sides not read. */
export const reconcile = (
  recorded: ReadonlyArray<RecordedRow>,
  previous: Consumption = new Map(),
  sides: { readonly clockify: boolean; readonly jira: boolean } = { clockify: true, jira: true },
  resolved?: ReadonlyArray<ResolvedEntry>
): Consumption => {
  const discovered: Consumption = new Map()
  for (const entry of markedEntries(recorded, resolved)) {
    const held = discovered.get(entry.key) ?? { clockify: 0, jira: 0 }
    discovered.set(entry.key, { ...held, [entry.source]: held[entry.source] + entry.seconds })
  }
  const reconciled: Consumption = new Map()
  for (const key of new Set([...previous.keys(), ...discovered.keys()])) {
    const old = previous.get(key) ?? { clockify: 0, jira: 0 }
    const fresh = discovered.get(key) ?? { clockify: 0, jira: 0 }
    const value = {
      clockify: sides.clockify ? fresh.clockify : old.clockify,
      jira: sides.jira ? fresh.jira : old.jira
    }
    if (value.clockify > 0 || value.jira > 0) reconciled.set(key, value)
  }
  return reconciled
}

/**
 * Where a block sits on a day column.
 *
 * **Mental model**
 *
 * - **Minutes from the top of the visible window, not pixels.** Geometry is one CSS variable; this
 *   module answers in the units the data is in and lets the stylesheet decide how tall an hour is.
 * - **Overlapping blocks share the width, the way a calendar does.** Two sessions running at once are
 *   two real things that happened at once, and stacking them would hide one of them.
 * - **Everything is clamped to its own day.** A block crossing local midnight belongs to two columns,
 *   and the half in each is what that column draws — the same split the engine's day buckets use.
 *
 * @module
 */

/** Anything with an instant and an end. Blocks keep their own payload; this only reads the times. */
export interface Timed {
  readonly startMs: number
  readonly endMs: number
}

/** Local midnight of `day`, and the midnight after it. */
export const dayBounds = (day: string): Timed => {
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0)
  return { endMs: end.getTime(), startMs: start.getTime() }
}

/** Minutes from local midnight. Read off the clock rather than measured, so a DST day still lines up. */
export const minutesIntoDay = (atMs: number): number => {
  const at = new Date(atMs)
  return at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60
}

/** One block's place in a column: when it starts, how long it is, and who it shares the width with. */
export interface Placed<A> {
  readonly block: A
  readonly startMinutes: number
  readonly endMinutes: number
  readonly column: number
  readonly columns: number
}

const clampToDay = <A extends Timed>(
  block: A,
  day: string
): { readonly startMinutes: number; readonly endMinutes: number } | null => {
  const bounds = dayBounds(day)
  const startMs = Math.max(block.startMs, bounds.startMs)
  const endMs = Math.min(block.endMs, bounds.endMs)
  if (endMs <= startMs) return null
  const startMinutes = minutesIntoDay(startMs)
  const clockEnd = endMs >= bounds.endMs ? 24 * 60 : minutesIntoDay(endMs)
  // The grid has one row per clock hour. Across a DST jump, project actual elapsed time from the
  // start instead of stretching a short spring block or reversing a repeated autumn hour.
  const crossedOffset = new Date(startMs).getTimezoneOffset() !== new Date(endMs).getTimezoneOffset()
  const endMinutes = crossedOffset && endMs < bounds.endMs
    ? Math.min(24 * 60, startMinutes + (endMs - startMs) / 60_000)
    : clockEnd
  return {
    endMinutes,
    startMinutes
  }
}

/**
 * Place every block that touches `day` into side-by-side columns.
 *
 * Blocks are grouped into clusters of mutual overlap, and the width is divided within a cluster
 * rather than across the day: one pair of overlapping blocks in the morning must not make the
 * afternoon's single block half-width.
 */
export const placeBlocks = <A extends Timed>(
  blocks: ReadonlyArray<A>,
  day: string,
  minimumMinutes = 0
): ReadonlyArray<Placed<A>> => {
  const clamped = blocks
    .flatMap((block) => {
      const bounds = clampToDay(block, day)
      return bounds === null ? [] : [{ block, ...bounds }]
    })
    // Earliest first, and the longer of two equal starts first, so a long block takes the left
    // column and the short ones stack to its right — which is how a calendar is read.
    .sort((a, b) => a.startMinutes === b.startMinutes ? b.endMinutes - a.endMinutes : a.startMinutes - b.startMinutes)

  const placed: Array<Placed<A>> = []
  let cluster: Array<{ block: A; startMinutes: number; endMinutes: number }> = []
  let clusterColumns: Array<number> = []
  let columnEnds: Array<number> = []
  let clusterEnd = -1

  const flush = () => {
    if (cluster.length === 0) return
    const columns = columnEnds.length
    for (const [index, entry] of cluster.entries()) {
      placed.push({ ...entry, column: clusterColumns[index]!, columns })
    }
    cluster = []
    columnEnds = []
    clusterColumns = []
    clusterEnd = -1
  }

  for (const entry of clamped) {
    // A block starting at or after everything before it ends begins a new cluster: nothing left to
    // share width with.
    if (entry.startMinutes >= clusterEnd) flush()
    const free = columnEnds.findIndex((end) => end <= entry.startMinutes)
    const column = free === -1 ? columnEnds.length : free
    const occupiedEnd = Math.max(entry.endMinutes, entry.startMinutes + minimumMinutes)
    columnEnds[column] = occupiedEnd
    clusterColumns.push(column)
    cluster.push(entry)
    clusterEnd = Math.max(clusterEnd, occupiedEnd)
  }
  flush()
  return placed
}

/** The hours a week's grid shows. */
export interface HourWindow {
  readonly fromHour: number
  readonly toHour: number
}

/** A working day, before anything is known about the week. */
export const DEFAULT_HOUR_WINDOW: HourWindow = { fromHour: 7, toHour: 20 }

/**
 * The hours to draw: a working day, widened to hold everything the week actually contains.
 *
 * Widened rather than scrolled to, because a block outside the window would otherwise be invisible —
 * and a 23:40 session is exactly the kind of thing someone opens this to find.
 */
export const hourWindow = (
  blocks: ReadonlyArray<Timed>,
  base: HourWindow = DEFAULT_HOUR_WINDOW
): HourWindow => {
  let fromHour = base.fromHour
  let toHour = base.toHour
  for (const block of blocks) {
    const start = new Date(block.startMs)
    const end = new Date(block.endMs)
    if (
      block.endMs > block.startMs &&
      (start.getFullYear() !== end.getFullYear() || start.getMonth() !== end.getMonth() ||
        start.getDate() !== end.getDate())
    ) {
      fromHour = 0
      toHour = 24
      continue
    }
    fromHour = Math.min(fromHour, start.getHours())
    // A block ending at 18:01 needs the 18:00 row drawn through 19:00.
    const endHour = end.getMinutes() > 0 || end.getSeconds() > 0 ? end.getHours() + 1 : end.getHours()
    toHour = Math.max(toHour, endHour)
  }
  return { fromHour: Math.max(0, fromHour), toHour: Math.min(24, Math.max(toHour, fromHour + 1)) }
}

/** The local time of a click at `offsetMinutes` into the window, as `HH:MM`. */
export const clockAtOffset = (window: HourWindow, offsetMinutes: number): string => {
  // Rounded to the quarter hour: a click is a gesture, not a measurement, and 14:00 is what someone
  // means when they click just below the 14:00 line.
  const quarter = Math.round((window.fromHour * 60 + offsetMinutes) / 15) * 15
  const windowStart = window.fromHour * 60
  // Clamped to the window rather than to the day: above the first row is the first row's hour, not
  // midnight, which is a time this grid is not even showing.
  const lastSlot = Math.min(window.toHour * 60, 24 * 60) - 15
  const minutes = Math.max(windowStart, Math.min(quarter, Math.max(windowStart, lastSlot)))
  const hours = Math.floor(minutes / 60) % 24
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

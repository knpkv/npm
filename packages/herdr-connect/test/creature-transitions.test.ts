import { describe, expect, it } from "vitest"
import * as task from "../src/creature-task.js"

describe("task transition ownership", () => {
  it("retains a failing one-shot through same-kind updates, queues only the newest kind, and never replays it", () => {
    expect(task).toHaveProperty("startTaskPlayback")
    const testing = task.startTaskPlayback("testing")
    const failing = task.updateTaskPlayback(testing, "failing", false)
    expect(failing.transition).toBe("failing")
    expect(failing.current.epoch).toBe(1)
    expect(task.updateTaskPlayback(failing, "failing", false)).toBe(failing)
    const waiting = task.updateTaskPlayback(failing, "waiting", false)
    const reading = task.updateTaskPlayback(waiting, "reading", false)
    expect(reading.current).toBe(failing.current)
    expect(reading.queued).toBe("reading")
    const next = task.finishTaskPlayback(reading, 1)
    expect(next.current.kind).toBe("reading")
    expect(next.transition).toBe("blend")
    expect(task.finishTaskPlayback(next, 1)).toBe(next)
  })

  it("keeps the terminal kind settled on mount and only celebrates an actual entry", () => {
    expect(task).toHaveProperty("startTaskPlayback")
    for (const kind of ["done", "failing"] satisfies ReadonlyArray<"done" | "failing">) {
      const settled = task.startTaskPlayback(kind)
      expect(settled.current.entered).toBe(false)
      expect(settled.transition).toBeNull()
      expect(task.updateTaskPlayback(settled, kind, false)).toBe(settled)
      const entering = task.updateTaskPlayback(task.startTaskPlayback("writing"), kind, false)
      expect(entering.transition).toBe(kind)
      const finished = task.finishTaskPlayback(entering, entering.current.epoch)
      expect(finished.current.entered).toBe(false)
      expect(task.updateTaskPlayback(finished, kind, false)).toBe(finished)
    }
  })

  it("uses the page16 precedence, including blocked-to-work hop and immediate reduced settlement", () => {
    expect(task).toHaveProperty("startTaskPlayback")
    const blocked = task.startTaskPlayback("blocked")
    for (const kind of ["reading", "writing", "testing"] satisfies ReadonlyArray<"reading" | "writing" | "testing">) {
      expect(task.updateTaskPlayback(blocked, kind, false).transition).toBe("hop")
    }
    expect(task.updateTaskPlayback(blocked, "failing", false).transition).toBe("failing")
    const active = task.updateTaskPlayback(blocked, "done", false)
    const queued = task.updateTaskPlayback(active, "waiting", false)
    const reduced = task.updateTaskPlayback(queued, "waiting", true)
    expect(reduced.current.kind).toBe("waiting")
    expect(reduced.current.entered).toBe(false)
    expect(reduced.transition).toBeNull()
    expect(reduced.outgoing).toBeNull()
    expect(task.updateTaskPlayback(reduced, "waiting", false)).toBe(reduced)
  })

  it("settles rows on the stage's still transform, as pages 13 and 14 hand rows the stage rm", () => {
    const kinds = [
      "reading",
      "writing",
      "testing",
      "waiting",
      "blocked",
      "failing",
      "done",
      "unknown"
    ] satisfies ReadonlyArray<task.TaskMotionKind>
    for (const kind of kinds) {
      expect(task.creatureTaskMotion(kind, false).restTransform).toBe(task.creatureTaskMotion(kind, true).restTransform)
    }
    expect(task.creatureTaskMotion("reading", false).restTransform).toContain("rotate(-3deg)")
    // Rows settle on the stage rest too: the reduced writing row keeps its tick, while the row loop stays tick-free.
    expect(task.creatureTaskMotion("writing", false).settled.ticks).toBe(
      task.creatureTaskMotion("writing", true).settled.ticks
    )
    expect(task.creatureTaskMotion("writing", false).frames).toEqual([])
  })
})

import { describe, expect, it } from "@effect/vitest"
import { makeTerminalWorkerGuard } from "../src/terminal-worker-guard.js"

describe("terminal worker callback ownership", () => {
  it("rejects a released worker when a remount reuses its request id", () => {
    const interruptedWorker = makeTerminalWorkerGuard(4)
    interruptedWorker.release()
    const remountedWorker = makeTerminalWorkerGuard(4)

    expect(interruptedWorker.accepts(4)).toBe(false)
    expect(remountedWorker.accepts(4)).toBe(true)
    expect(remountedWorker.accepts(5)).toBe(false)
  })
})

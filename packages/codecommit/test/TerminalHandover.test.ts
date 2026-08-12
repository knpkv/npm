import { describe, expect, it } from "@effect/vitest"
import { type InterruptSignals, suppressInterruptTeardown } from "../src/tui/terminal-handover.js"

type Listener = (signal: string) => void

const recordingSignals = (initial: ReadonlyArray<Listener>) => {
  let installed: Array<Listener> = [...initial]
  const ignore: Listener = () => {}
  const signals: InterruptSignals<Listener> = {
    ignore,
    listeners: () => [...installed],
    off: (listener) => {
      installed = installed.filter((candidate) => candidate !== listener)
    },
    on: (listener) => {
      installed.push(listener)
    }
  }
  return { ignore, installed: () => installed, signals }
}

describe("interrupt teardown bracket", () => {
  it("replaces the teardown listeners with a no-op so the signal cannot kill the session", () => {
    const teardown: Listener = () => {}
    const other: Listener = () => {}
    const host = recordingSignals([teardown, other])

    const restore = suppressInterruptTeardown(host.signals)

    // A no-op must remain installed: with no listener at all Node terminates by default,
    // which would end the session just as surely as runMain's handler.
    expect(host.installed()).toEqual([host.ignore])

    restore()
    expect(host.installed()).toEqual([teardown, other])
  })

  it("restores at most once so a resume and a scope finalizer cannot duplicate teardown", () => {
    const teardown: Listener = () => {}
    const host = recordingSignals([teardown])

    const restore = suppressInterruptTeardown(host.signals)
    restore()
    restore()

    expect(host.installed()).toEqual([teardown])
  })

  it("refuses a second suppression so the saved teardown listeners cannot be lost", () => {
    const teardown: Listener = () => {}
    const host = recordingSignals([teardown])

    const restore = suppressInterruptTeardown(host.signals)
    // Suppressing again would save the already-suppressed list, leaving the session
    // permanently deaf to Ctrl-C once both brackets restored.
    const secondRestore = suppressInterruptTeardown(host.signals)
    expect(host.installed()).toEqual([host.ignore])

    secondRestore()
    expect(host.installed()).toEqual([host.ignore])

    restore()
    expect(host.installed()).toEqual([teardown])
  })

  it("still installs the guard when nothing was listening", () => {
    const host = recordingSignals([])

    const restore = suppressInterruptTeardown(host.signals)
    expect(host.installed()).toEqual([host.ignore])

    restore()
    expect(host.installed()).toEqual([])
  })
})

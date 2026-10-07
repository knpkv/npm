/**
 * QA-J50: every CLI failure printed "Monitor failed. Check configuration, credentials and snapshot."
 * Each now prints one line naming the setting or argument to fix, and none carries a key, an input
 * path or the monitor origin.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  describeFailure,
  InvalidSetting,
  KeysExist,
  MissingSetting,
  SnapshotFileInvalid,
  SnapshotFileUnreadable
} from "../src/failure.js"
import { InvalidOrigin, InvalidPublishToken, MonitorUnreachable, PublishRejected } from "../src/publisher.js"
import { MonitorConfigurationError } from "../src/server.js"

describe("describeFailure", () => {
  it("names the variable that is not set and how to make it", () => {
    expect(describeFailure(new MissingSetting({ name: "MONITOR_VIEW_TOKEN" }))).toBe(
      "MONITOR_VIEW_TOKEN is not set. Run: herdr-monitor init, then load the file it writes."
    )
    expect(describeFailure(new InvalidSetting({ name: "MONITOR_PORT", value: "4999x" }))).toBe(
      "MONITOR_PORT=4999x is not a port number (1–65535)."
    )
  })

  it("names the setting the server refused, with its rule", () => {
    expect(describeFailure(new MonitorConfigurationError({ setting: "independentTokens" }))).toBe(
      "MONITOR_PUBLISH_TOKEN and MONITOR_VIEW_TOKEN must be two different keys. Run: herdr-monitor init"
    )
    expect(describeFailure(new InvalidPublishToken())).toBe(
      "MONITOR_PUBLISH_TOKEN must be publish_ followed by 43 base64url characters. Run: herdr-monitor init"
    )
    expect(describeFailure(new InvalidOrigin({ origin: "http://monitor.local" }))).toBe(
      "MONITOR_ORIGIN must be https://host[:port] or http://127.0.0.1:port, with no path."
    )
  })

  it("names the snapshot file and what is wrong with it", () => {
    expect(describeFailure(new SnapshotFileUnreadable({ file: "missing.json", reason: "no such file" }))).toBe(
      "Cannot read the snapshot file: no such file."
    )
    expect(describeFailure(new SnapshotFileInvalid({ file: "board.json", reason: "Missing key\n  at [\"agents\"]" })))
      .toBe("The snapshot file is not a valid snapshot: Missing key at [\"agents\"]")
  })

  // scripts/packed.mjs asserts the same against the packed CLI: an origin or path can name something private.
  it("never prints the origin, the file path or a non-port value", () => {
    const lines = [
      describeFailure(new InvalidOrigin({ origin: "https://private-monitor.example:99999" })),
      describeFailure(new MonitorUnreachable({ origin: "https://private-monitor.example", reason: "ECONNREFUSED" })),
      describeFailure(new SnapshotFileUnreadable({ file: "/home/u/private/board.json", reason: "no such file" })),
      describeFailure(new InvalidSetting({ name: "MONITOR_BIND", value: "private-host.internal" }))
    ].join("\n")
    expect(lines).not.toContain("private")
  })

  it("says what each refusal from the monitor means", () => {
    const at = "http://127.0.0.1:4319"
    expect(describeFailure(new PublishRejected({ origin: at, status: 401 }))).toBe(
      "The monitor refused the snapshot (HTTP 401): MONITOR_PUBLISH_TOKEN is not the server's publish key."
    )
    expect(describeFailure(new PublishRejected({ origin: at, status: 409 }))).toContain("publish a higher sequence")
    expect(describeFailure(new MonitorUnreachable({ origin: at, reason: "Transport error" }))).toBe(
      "Cannot reach the monitor at MONITOR_ORIGIN. Is herdr-monitor serve running there?"
    )
    expect(describeFailure(new KeysExist({ path: "/home/u/.config/herdr-monitor/monitor.env" }))).toContain(
      "never replaces them"
    )
  })
})

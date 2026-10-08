import { describe, expect, it } from "vitest"
import { duration, limitsView } from "../src/limits-model.js"
import type { AgentLimits, FleetLimits, HostLimits, LimitProvider, LimitWindowState } from "../src/limits-schema.js"

const HOUR = 3_600_000
const now = 1_000 * HOUR
const time = (millis: number) => `T+${String((millis - now) / HOUR)}h`

/** A reading `ago` old when the CLI ran at `now`; the CLI reports both the time and the age. */
const known = (
  usedPercent: number,
  overrides: Partial<Extract<LimitWindowState, { _tag: "Known" }>> = {},
  ago = 60_000
) =>
  ({
    _tag: "Known",
    usedPercent,
    resetsAt: now + 10 * HOUR,
    observedAt: now - ago,
    ageMs: ago,
    burnPerHour: { _tag: "Known", value: 1 },
    exhaustsAt: { _tag: "Known", value: "NotBeforeReset" },
    source: "statusline",
    ...overrides
  }) satisfies LimitWindowState

const provider = (
  windows: ReadonlyArray<readonly ["five_hour" | "weekly", LimitWindowState]>,
  extra: Partial<LimitProvider> = {}
): LimitProvider => ({ reservePp: 15, windows: windows.map(([window, state]) => ({ window, state })), ...extra })

const account = (id: string, label: string): Partial<LimitProvider> => ({ account: { _tag: "Known", id, label } })

const limits = (claude: LimitProvider, codex: LimitProvider = provider([])): AgentLimits => ({
  v: 1,
  now,
  providers: { claude, codex }
})

const read = (host: string, value: AgentLimits): HostLimits => ({
  host,
  readAt: now,
  reading: { _tag: "Read", limits: value }
})

const fleet = (...hosts: ReadonlyArray<HostLimits>): FleetLimits => ({ hosts, failures: [], peersListed: true })

describe("limitsView", () => {
  it("never turns an unknown window into a number", () => {
    const view = limitsView(
      fleet(read("SER8", limits(provider([["weekly", { _tag: "Unknown", reason: "Stale", ageMs: 6 * HOUR }]])))),
      { sinceLoad: 0, now },
      time
    )
    const weekly = view.accounts[0]?.windows[0]
    expect(weekly).toMatchObject({ name: "Weekly", tone: "unknown", value: null, detailText: "No reading for 6h 0m" })
  })

  it("keeps an old reading's number but calls it old, the way LimitTrack draws it", () => {
    const old = known(47, {}, 2 * HOUR)
    const view = limitsView(fleet(read("SER8", limits(provider([["weekly", old]])))), { sinceLoad: 0, now }, time)
    expect(view.accounts[0]?.windows[0]).toMatchObject({
      tone: "unknown",
      value: 47,
      stale: true,
      usedText: "47% used, old reading",
      detailText: null,
      sourceText: "read on SER8, 2h 0m ago"
    })
  })

  it("takes the freshest reading of one account across hosts and names that host", () => {
    const view = limitsView(
      fleet(
        read("SER8", limits(provider([["weekly", known(40, {}, 10 * 60_000)]], account("a", "a@example.com")))),
        read("PI", limits(provider([["weekly", known(44, {}, 2 * 60_000)]], account("a", "a@example.com"))))
      ),
      { sinceLoad: 0, now },
      time
    )
    // One Claude account; Codex names none, so each host's empty Codex read stays its own.
    expect(view.accounts.map((entry) => [entry.name, entry.account ?? entry.host, entry.windows.length])).toEqual([
      ["Claude", "a@example.com", 1],
      ["Codex", "PI", 0],
      ["Codex", "SER8", 0]
    ])
    expect(view.accounts[0]?.windows[0]).toMatchObject({ value: 44, sourceText: "read on PI, 2m ago" })
  })

  it("prefers a host that has a reading over a fresher one that has none", () => {
    const view = limitsView(
      fleet(
        read("SER8", limits(provider([["weekly", known(40)]], account("a", "a@example.com")))),
        read(
          "PI",
          limits(
            provider(
              [["weekly", { _tag: "Unknown", reason: "Missing", observedAt: now }]],
              account("a", "a@example.com")
            )
          )
        )
      ),
      { sinceLoad: 0, now },
      time
    )
    expect(view.accounts[0]?.windows[0]?.value).toBe(40)
  })

  it("shows two accounts of one provider side by side, by their labels", () => {
    const view = limitsView(
      fleet(
        read("SER8", limits(provider([["weekly", known(40)]], account("a", "andrey@work.example")))),
        read("PI", limits(provider([["weekly", known(70)]], account("b", "andrey@home.example"))))
      ),
      { sinceLoad: 0, now },
      time
    )
    const claude = view.accounts.filter((entry) => entry.provider === "claude")
    expect(claude.map((entry) => [entry.name, entry.account, entry.windows[0]?.value])).toEqual([
      ["Claude", "andrey@home.example", 70],
      ["Claude", "andrey@work.example", 40]
    ])
  })

  it("says near limit inside the reserve or when the pace runs out before reset", () => {
    const view = limitsView(
      fleet(
        read(
          "SER8",
          limits(
            provider([
              ["five_hour", known(86)],
              ["weekly", known(50, { exhaustsAt: { _tag: "Known", value: now + 5 * HOUR } })]
            ])
          )
        )
      ),
      { sinceLoad: 0, now },
      time
    )
    const [fiveHour, weekly] = view.accounts[0]?.windows ?? []
    expect(fiveHour).toMatchObject({ tone: "near", reserveMark: 85, paceText: "inside the reserve" })
    expect(weekly).toMatchObject({ tone: "near", paceText: "reaches the reserve T+5h", projected: 60 })
  })

  it("headlines the window closest to its limit", () => {
    const view = limitsView(
      fleet(read("SER8", limits(provider([["five_hour", known(20)], ["weekly", known(100)]])))),
      { sinceLoad: 0, now },
      time
    )
    expect(view.accounts[0]?.headline).toMatchObject({ name: "Weekly", tone: "at-limit" })
  })

  it("leaves out windows the provider doesn't report, and names hosts without a reading", () => {
    const view = limitsView(
      {
        hosts: [
          read("SER8", limits(provider([["five_hour", { _tag: "NotReported" }]]))),
          { host: "MBP", readAt: now, reading: { _tag: "Unavailable", reason: "not_configured", detail: "" } }
        ],
        failures: [{ host: "PI", reason: "offline" }],
        peersListed: true
      },
      { sinceLoad: 0, now },
      time
    )
    expect(view.accounts[0]?.windows).toEqual([])
    expect(view.accounts[0]?.headline).toBeNull()
    expect(view.notes).toEqual(["Limits are off on MBP", "No reading from PI (offline)"])
  })
})

describe("limitsView clocks and words", () => {
  it("keeps an unnamed account per host, so two subscriptions never merge", () => {
    const view = limitsView(
      fleet(
        read("SER8", limits(provider([["weekly", known(40)]]))),
        read("PI", limits(provider([["weekly", known(70)]])))
      ),
      { sinceLoad: 0, now },
      time
    )
    const claude = view.accounts.filter((entry) => entry.provider === "claude")
    expect(claude.map((entry) => [entry.host, entry.account, entry.windows[0]?.value])).toEqual([
      ["PI", null, 70],
      ["SER8", null, 40]
    ])
  })

  it("reads a host's times on its own clock, however far it is from this page's", () => {
    const hostNow = now + 3 * HOUR
    const skewed: AgentLimits = {
      v: 1,
      now: hostNow,
      providers: {
        claude: provider([
          [
            "five_hour",
            known(30, {
              observedAt: hostNow - 60_000,
              resetsAt: hostNow + 2 * HOUR,
              exhaustsAt: { _tag: "Known", value: hostNow + HOUR }
            })
          ]
        ]),
        codex: provider([])
      }
    }
    const window = limitsView(fleet(read("SER8", skewed)), { sinceLoad: 0, now }, time).accounts[0]?.windows[0]
    expect(window).toMatchObject({ stale: false, detailText: "resets in 2h 0m", paceText: "reaches the reserve T+1h" })
  })

  it("ages a reading by the time since the page received it", () => {
    const view = limitsView(
      fleet(read("SER8", limits(provider([["five_hour", known(30)]])))),
      { sinceLoad: 20 * 60_000, now: now + 20 * 60_000 },
      time
    )
    expect(view.accounts[0]?.windows[0]).toMatchObject({ stale: true, sourceText: "read on SER8, 21m ago" })
  })

  it("prints whole percents", () => {
    const view = limitsView(
      fleet(read("SER8", limits(provider([["weekly", known(47.333)]])))),
      { sinceLoad: 0, now },
      time
    )
    expect(view.accounts[0]?.windows[0]?.usedText).toBe("47% used")
  })

  it("says the other machines are unknown when the hub could not list them", () => {
    const view = limitsView(
      { ...fleet(read("SER8", limits(provider([])))), peersListed: false },
      { sinceLoad: 0, now },
      time
    )
    expect(view.notes).toEqual(["Other machines unknown: the hub couldn't list the fleet"])
  })
})

describe("duration", () => {
  it("uses the two largest units and never says 0m", () => {
    expect(duration(3 * 24 * HOUR + 4 * HOUR)).toBe("3d 4h")
    expect(duration(2 * HOUR + 5 * 60_000)).toBe("2h 5m")
    expect(duration(10_000)).toBe("1m")
  })
})

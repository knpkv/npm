// @vitest-environment happy-dom
import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { HostResourcesView } from "../src/resources-module-view.js"
import { memoryPaths } from "../src/resources-view-model.js"
import { resourceFixtureNow, resourcesFixture, resourcesStates } from "./superapp-browser/resources-fixture.js"

const regions = ["memory", "trend", "cpu", "disk", "gate", "jobs", "previews", "top"]
describe("host resource reference states", () => {
  it.each(resourcesStates)("renders %s with distinct reference regions and read-only controls", (state) => {
    const fixture = resourcesFixture(state)
    const root = document.createElement("div")
    root.innerHTML = renderToStaticMarkup(<HostResourcesView {...fixture} now={resourceFixtureNow} />)
    expect(root.querySelector("h1")?.textContent).toBe("Host resources")
    expect(root.textContent).not.toContain("·")
    expect(root.querySelector('[data-region="header"]')?.textContent).toContain("maple")
    expect([...root.querySelectorAll("[data-region]")].map((element) => element.getAttribute("data-region"))).toEqual(
      state === "host-offline-never"
        ? ["header", "notice"]
        : state === "host-offline"
          ? ["header", "notice", ...regions]
          : ["header", ...regions]
    )
    expect(
      [...root.querySelectorAll("button, a, summary")].map((element) => element.textContent).join(" ")
    ).not.toMatch(/kill|release|retry|stop|terminal/i)
    expect(root.querySelectorAll('a[href="#"]')).toHaveLength(0)
    if (state === "loading") expect(root.querySelectorAll('[aria-busy="true"]')).toHaveLength(8)
    if (state === "live-healthy") expect(root.textContent).toContain("Room for a heavy job")
    if (state === "live-busy") {
      expect(root.textContent).toContain("Below heavy start")
      expect(root.textContent).toContain("Full gate waiting for slot 2")
      expect(root.textContent).toContain("Show 9 more")
    }
    if (state === "below-abort") expect(root.textContent).toContain("Below abort.Heavy jobs should stop.")
    if (state === "lock-held-too-long") {
      expect(root.textContent).toContain("Held past its 30m limit")
      expect(root.textContent).toContain("Held past its 20m deadline")
    }
    if (state === "stale") {
      expect(root.textContent).toContain("Stale, sampled 2m ago")
      expect(root.querySelector("[data-old]")).not.toBeNull()
      expect(root.querySelector('[data-region="trend"] svg')?.getAttribute("aria-label")).toContain(
        "Last values, not current"
      )
    }
    if (state === "host-offline") {
      expect(root.textContent).toContain("maple is offline. Last sample 14:02.")
      expect(root.textContent).toContain("Last known, 14:02")
    }
    if (state === "section-unavailable") {
      expect(root.textContent?.match(/Not configured on this host/g)).toHaveLength(2)
      expect(root.textContent).toContain("Agent names unavailable: herdr is not answering.")
      expect(root.textContent).toContain("pid 41822")
    }
    if (state === "warming-up") expect(root.textContent).toContain("8 min of history")
    if (state === "host-offline-never") expect(root.textContent).toContain("No reading from maple yet.")
  })
  it("leaves a gap between disjoint history samples", () => {
    const paths = memoryPaths(
      [
        { sampledAt: 1000, availableBytes: 10 },
        { sampledAt: 11000, availableBytes: 9 },
        { sampledAt: 40000, availableBytes: 8 }
      ],
      40000,
      16
    )
    expect(paths).toHaveLength(2)
    expect(paths[0]?.line.match(/L/g)).toHaveLength(1)
    expect(paths[1]?.line).not.toContain("L")
  })
  it("shows the designed circled memory check beside its positive state text", () => {
    const root = document.createElement("div")
    root.innerHTML = renderToStaticMarkup(
      <HostResourcesView {...resourcesFixture("live-healthy")} now={resourceFixtureNow} />
    )
    const memory = root.querySelector('[data-region="memory"]')
    expect(memory?.textContent).toContain("Room for a heavy job")
    expect(memory?.querySelector('svg[aria-hidden="true"] circle[r="10"]')).not.toBeNull()
  })
  it("exposes quota values and old-reading context on the styled meter", () => {
    const root = document.createElement("div")
    root.innerHTML = renderToStaticMarkup(<HostResourcesView {...resourcesFixture("stale")} now={resourceFixtureNow} />)
    const meter = root.querySelector('[role="meter"]')
    expect(meter?.getAttribute("aria-valuemin")).toBe("0")
    expect(Number(meter?.getAttribute("aria-valuemax"))).toBe(6 * 1024 ** 3)
    expect(Number(meter?.getAttribute("aria-valuenow"))).toBe(1.8 * 1024 ** 3)
    expect(meter?.getAttribute("aria-label")).toBe("/tmp, last values, not current, 30% of quota used")
  })
  it.each(["live-busy", "lock-held-too-long"] satisfies ReadonlyArray<Parameters<typeof resourcesFixture>[0]>)(
    "keeps %s slot copy compact and job grant copy explicit",
    (state) => {
      const root = document.createElement("div")
      root.innerHTML = renderToStaticMarkup(<HostResourcesView {...resourcesFixture(state)} now={resourceFixtureNow} />)
      const slot = root.querySelectorAll('[data-region="gate"] .hr-slot')[1]
      const rows = new Map(
        [...(slot?.querySelectorAll("dl > div") ?? [])].map(
          (row) =>
            [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent] satisfies readonly [
              string | null | undefined,
              string | null | undefined
            ]
        )
      )
      expect(rows.get("Grant")).toBe("none")
      expect(rows.get("Limit")).toBe(state === "live-busy" ? "limit 30m" : "deadline 20m")
      expect(root.querySelector('[data-region="jobs"]')?.textContent).toContain("no grant on cmdline")
    }
  )
  it("shows Open unavailable rather than inventing a link before the loopback probe succeeds", () => {
    const fixture = resourcesFixture("live-healthy")
    const snapshot = fixture.snapshot
    if (snapshot === null || snapshot.previews._tag !== "Reading") throw new TypeError("preview fixture missing")
    const root = document.createElement("div")
    root.innerHTML = renderToStaticMarkup(
      <HostResourcesView
        {...fixture}
        snapshot={{
          ...snapshot,
          previews: {
            _tag: "Reading",
            value: snapshot.previews.value.map((preview) => ({
              ...preview,
              open: { _tag: "Unavailable", reason: "no_dns_name" }
            }))
          }
        }}
        now={resourceFixtureNow}
      />
    )
    expect(root.querySelectorAll('[data-region="previews"] a')).toHaveLength(0)
    expect(root.textContent).toContain("Open unavailable")
  })
})

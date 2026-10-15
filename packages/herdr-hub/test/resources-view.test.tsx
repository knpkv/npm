// @vitest-environment happy-dom
import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { HostResourcesView } from "../src/resources-module-view.js"
import { memoryPaths } from "../src/resources-view-model.js"
import { resourceFixtureNow, resourcesFixture, resourcesStates } from "./superapp-browser/resources-fixture.js"

import exported from "./fixtures/host-resources.json" with { type: "json" }

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

it("breaks CPU paths at missing sampling intervals while retaining ordinary jitter", () => {
  for (const [times, moves] of [
    [[-40_000, -30_000, 0], 2],
    [[-25_000, -15_000, 0], 1]
  ] satisfies ReadonlyArray<readonly [ReadonlyArray<number>, number]>) {
    const fixture = resourcesFixture("live-healthy")
    const snapshot = fixture.snapshot
    if (snapshot === null || snapshot.cpu._tag !== "Reading") throw new TypeError("CPU fixture missing")
    const root = document.createElement("div")
    root.innerHTML = renderToStaticMarkup(
      <HostResourcesView
        {...fixture}
        snapshot={{
          ...snapshot,
          cpu: {
            _tag: "Reading",
            value: {
              ...snapshot.cpu.value,
              history: times.map((offset, index) => ({
                sampledAt: snapshot.sampledAt + offset,
                percent: 10 + index * 10
              }))
            }
          }
        }}
        now={resourceFixtureNow}
      />
    )
    const path = root.querySelector('[data-region="cpu"] .hr-spark path')?.getAttribute("d") ?? ""
    expect(path.match(/M/g)).toHaveLength(moves)
    expect(path.match(/L/g)).toHaveLength(3 - moves)
  }
})
it("densifies reference CPU controls without losing any original vertex or inventing gaps", () => {
  const fixture = resourcesFixture("live-healthy")
  const snapshot = fixture.snapshot
  if (snapshot === null || snapshot.cpu._tag !== "Reading") throw new TypeError("CPU fixture missing")
  const points = snapshot.cpu.value.history
  const controls = exported.data.hostResources.readings.healthy.cpu.spark
  expect(controls).toHaveLength(60)
  expect(points.length).toBeLessThanOrEqual(360)
  for (let i = 1; i < points.length; i++)
    expect((points[i]?.sampledAt ?? 0) - (points[i - 1]?.sampledAt ?? 0)).toBeLessThanOrEqual(15_000)
  const root = document.createElement("div")
  root.innerHTML = renderToStaticMarkup(<HostResourcesView {...fixture} now={resourceFixtureNow} />)
  const path = root.querySelector('[data-region="cpu"] .hr-spark path')?.getAttribute("d") ?? ""
  expect(path.match(/M/g)).toHaveLength(1)
  for (const [index, percent] of controls.entries()) {
    expect(points).toContainEqual({
      sampledAt: snapshot.sampledAt - ((controls.length - 1 - index) / (controls.length - 1)) * 3_590_000,
      percent
    })
    expect(path).toContain(
      `${((index / (controls.length - 1)) * 160).toFixed(1)} ${(36 - (percent / 100) * 36).toFixed(1)}`
    )
  }
})
it("describes disk-backed and unknown /tmp as filesystem capacity, keeping tmpfs memory quota wording", () => {
  for (const fsType of ["overlayfs", "unknown", "tmpfs"]) {
    const fixture = resourcesFixture("live-healthy")
    const snapshot = fixture.snapshot
    if (snapshot === null || snapshot.tmp._tag !== "Reading") throw new TypeError("tmp fixture missing")
    const root = document.createElement("div")
    root.innerHTML = renderToStaticMarkup(
      <HostResourcesView
        {...fixture}
        snapshot={{ ...snapshot, tmp: { _tag: "Reading", value: { ...snapshot.tmp.value, fsType } } }}
        now={resourceFixtureNow}
      />
    )
    const disk = root.querySelector('[data-region="disk"]')
    const tmp = [...(disk?.querySelectorAll(".hr-fs > div") ?? [])].find((row) =>
      row.querySelector("b")?.textContent?.startsWith("/tmp")
    )
    expect(tmp?.querySelector("b")?.textContent).toBe(fsType === "tmpfs" ? "/tmp (memory)" : "/tmp")
    expect(tmp?.textContent?.includes("quota")).toBe(fsType === "tmpfs")
    if (fsType !== "tmpfs") {
      expect(tmp?.textContent).toContain("1.8 GiB used")
      expect(tmp?.textContent).toContain("4.2 GiB free of 6 GiB")
      expect(tmp?.querySelector('[role="meter"]')).toBeNull()
    }
  }
})
it("shows the designed unknown slot without claiming Free or exposing invented holder facts", () => {
  const fixture = resourcesFixture("gate-holder-unknown")
  const root = document.createElement("div")
  root.innerHTML = renderToStaticMarkup(<HostResourcesView {...fixture} now={resourceFixtureNow} />)
  const unknown = root.querySelector('[data-region="gate"] .hr-slot')
  expect(unknown?.querySelector(".hr-word")?.textContent).toBe("Unknown")
  expect(unknown?.textContent).toContain("Holder not readable on this host.")
  expect(unknown?.querySelector(".hr-wait")?.textContent).toBe("Holder not readable on this host.")
  expect(unknown?.textContent).not.toMatch(/Free|Held|Lane|Grant/)
  expect(unknown?.querySelector("dl")).toBeNull()
  expect(root.querySelector('[data-region="gate"] .hr-slot:nth-child(2)')?.textContent).toContain("Held")
  expect(root.querySelectorAll('[data-region="jobs"] .hr-jrow')).toHaveLength(1)
})

import { NodeServices } from "@effect/platform-node"
import { it as effectIt } from "@effect/vitest"
import { Identity } from "@knpkv/design-conformance"
import { FleetLimits, FleetUsage } from "@knpkv/herdr-connect"
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  readinessFailure,
  seedDashboardHtml,
  usageFontPreload,
  usageInventoryFile
} from "../scripts/design-conformance.js"
import { designDashboard, designReadings, fixtureNow, UsageDesignFixture } from "../scripts/design-fixture.js"
import { RenderedFontReply, renderedFontUsage } from "../scripts/design-fonts.js"
import { fontPreloadLink, PRELOADED_FONTS } from "../src/font-preload.js"
import { dashboardPage } from "../src/internal/dashboard-page.js"
import { usageLimitsInventory } from "../src/internal/usage-limits-inventory.js"

const Envelope = Schema.Struct({ version: Schema.Literal(1), data: UsageDesignFixture })
const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(
  readFileSync(new URL("../../../design-refs/super-app/fixture.json", import.meta.url), "utf8")
).data
const input = Schema.encodeSync(UsageDesignFixture)(fixture)

const readingsFor = (name: string) => {
  const state = fixture.usageLimits.states[name]
  if (state === undefined) return expect.unreachable(`Missing ${name} fixture`)
  return designReadings(fixture, state)
}

describe("Usage design transport", () => {
  it("rejects CSS-family-only evidence, local fallback glyphs and foreign custom faces", () => {
    const identity = { screen: "usage-limits", state: "empty", viewport: 390, theme: "light" } satisfies Identity
    const geist = { familyName: "Geist", postScriptName: "Geist-Regular", isCustomFont: true, glyphCount: 22 }
    for (
      const reply of [
        { fonts: [] },
        { fonts: [{ ...geist, glyphCount: 0 }] },
        { fonts: [{ ...geist, isCustomFont: false }] },
        { fonts: [{ ...geist, familyName: "Liberation Sans", postScriptName: "LiberationSans" }] },
        { fonts: [geist, { ...geist, isCustomFont: false }] }
      ]
    ) {
      const result = renderedFontUsage(identity, "See fleet token readings", false, reply)
      if (Result.isSuccess(result)) return expect.unreachable("Unproven rendered face accepted")
      expect(result.failure._tag).toBe("RunnerFailure")
      expect(result.failure.detail).toContain(JSON.stringify(identity))
      expect(result.failure.detail).toContain("See fleet token readings")
    }
    expect(Result.isSuccess(renderedFontUsage(identity, "UI", false, { fonts: [geist] }))).toBe(true)
    const mono = { ...geist, familyName: "Geist Mono", postScriptName: "GeistMono-Regular" }
    expect(Result.isSuccess(renderedFontUsage(identity, "Ctrl J", true, { fonts: [mono] }))).toBe(true)
    expect(Result.isFailure(renderedFontUsage(identity, "Ctrl J", true, { fonts: [geist] }))).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(RenderedFontReply)({
        fonts: [{ ...geist, glyphCount: "22" }]
      })
    )).toBe(true)
  })
  it("seeds identity and both theme markers in the app HTML before its deferred client runs", () => {
    const state = fixture.usageLimits.states.populated
    if (state === undefined) return expect.unreachable()
    const html = dashboardPage(designDashboard(fixture, state), "")
    expect(html).not.toContain("data-design-state")
    for (const live of usageLimitsInventory.states) {
      for (const theme of live.themes) {
        const identity = Schema.decodeUnknownSync(Identity)({
          screen: live.screen,
          state: live.state,
          viewport: 390,
          theme
        })
        const result = seedDashboardHtml(html, identity)
        if (Result.isFailure(result)) return expect.unreachable(result.failure.detail)
        expect(result.success).toContain(
          `<html lang="en" data-design-state="${live.state}" data-design-theme="${theme}">`
        )
        expect(result.success).toContain(`<meta name="color-scheme" content="${theme}">`)
        expect(result.success).toContain(`<body data-rly-root data-rly-theme="${theme}">`)
        expect(result.success).toContain("<script src=\"/assets/approval.js\" defer></script>")
      }
    }
  })

  it("rejects changed app HTML markers instead of silently leaving a readiness term unseeded", () => {
    const state = fixture.usageLimits.states.populated
    if (state === undefined) return expect.unreachable()
    const html = dashboardPage(designDashboard(fixture, state), "")
    const identity = { screen: "usage-limits", state: "populated", viewport: 390, theme: "light" } satisfies Identity
    for (
      const marker of [
        "<html lang=\"en\">",
        "<meta name=\"color-scheme\" content=\"dark\">",
        "<body data-rly-root data-rly-theme=\"dark\">"
      ]
    ) {
      const result = seedDashboardHtml(html.replace(marker, ""), identity)
      if (Result.isSuccess(result)) return expect.unreachable("Missing marker accepted")
      expect(result.failure._tag).toBe("RunnerFailure")
      expect(result.failure.detail).toContain(marker)
      expect(result.failure.detail).toContain(JSON.stringify(identity))
    }
  })

  it("reports the failing shot and every actual readiness term, including absent identity and a wrong body theme", () => {
    const identity = { screen: "usage-limits", state: "populated", viewport: 390, theme: "light" } satisfies Identity
    const values = {
      designState: null,
      designTheme: null,
      rlyTheme: "dark",
      headingFound: true,
      limitsPageCurrent: true
    }
    const failure = readinessFailure(identity, values, "TimeoutError: page.waitForFunction: Timeout 30000ms exceeded")
    expect(failure._tag).toBe("RunnerFailure")
    expect(failure.detail).toContain(JSON.stringify(identity))
    expect(failure.detail).toContain(JSON.stringify(values))
    expect(failure.detail).toContain("TimeoutError: page.waitForFunction: Timeout 30000ms exceeded")
  })

  it("rejects a reading state without readings instead of rendering an empty success", () => {
    expect(() =>
      Schema.decodeUnknownSync(UsageDesignFixture)({
        ...input,
        usageLimits: { ...input.usageLimits, states: { populated: {} } }
      })
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(UsageDesignFixture)(input)).not.toThrow()
  })

  it("covers every app-owned state with schema-valid wire responses", () => {
    expect(Object.keys(fixture.usageLimits.states).sort()).toEqual(
      usageLimitsInventory.states.map((state) => state.state).sort()
    )
    expect(usageLimitsInventory.routes).toEqual(["/?range=7d&timeZone=UTC#usage/limits"])
    for (const state of usageLimitsInventory.states) {
      const readings = readingsFor(state.state)
      expect(() => Schema.decodeUnknownSync(FleetLimits)(readings.limits)).not.toThrow()
      expect(() => Schema.decodeUnknownSync(FleetUsage)(readings.usage)).not.toThrow()
    }
  })

  it("uses fixture levels, freshness and reset instants without replacing unknown with zero", () => {
    for (const name of ["populated", "near-limit", "limit-reached", "stale", "sign-in-required"]) {
      const state = fixture.usageLimits.states[name]
      if (state === undefined) return expect.unreachable()
      const readings = readingsFor(name)
      const host = readings.limits.hosts[0]
      if (host?.reading._tag !== "Read") return expect.unreachable()
      const expected = (state.limits ?? []).flatMap((entry) => [entry.fiveHour.used, entry.weekly.used])
      expect(
        host.reading.limits.latest.map((entry) => entry.reading._tag === "Known" ? entry.reading.usedPercent : null)
      )
        .toEqual(expected)
      expect(host.reading.limits.latest.map((entry) => entry.observedAt)).toEqual(
        name === "stale"
          ? Array(4).fill(fixtureNow - (4 * 60 + 50) * 60_000)
          : [fixtureNow - 60_000, fixtureNow - 60_000, fixtureNow, fixtureNow]
      )
      const resets = host.reading.limits.latest.map((entry) =>
        entry.reading._tag === "Known" ? entry.reading.resetsAt : null
      )
      expect(resets.slice(0, 2)).toEqual([
        fixtureNow + (2 * 60 + 38) * 60_000,
        fixtureNow + (2 * 24 * 60 + 16 * 60 + 58) * 60_000
      ])
      expect(resets.slice(2)).toEqual(
        name === "sign-in-required" ? [null, null] : [
          fixtureNow + (3 * 60 + 13) * 60_000,
          fixtureNow + (24 * 60 + 13 * 60 + 27) * 60_000
        ]
      )
    }
  })

  it("rejects a changed export date and malformed read time before transport seeding", () => {
    expect(() =>
      Schema.decodeUnknownSync(UsageDesignFixture)({
        usageLimits: { ...input.usageLimits, meta: { date: "Monday 12 October 2026" } }
      })
    ).toThrow()
    const state = input.usageLimits.states.populated
    if (state?.limits === undefined) return expect.unreachable()
    const limits = state.limits
    expect(() =>
      Schema.decodeUnknownSync(UsageDesignFixture)({
        usageLimits: {
          ...input.usageLimits,
          states: { populated: { ...state, limits: limits.map((reading) => ({ ...reading, readAt: "24:99" })) } }
        }
      })
    ).toThrow()
  })

  it("bootstraps synthetic approvals from the same shell counts, including the empty override", () => {
    const populated = fixture.usageLimits.states.populated
    const empty = fixture.usageLimits.states.empty
    if (populated === undefined || empty === undefined) return expect.unreachable()
    expect(designDashboard(fixture, populated).pendingApprovals.local).toHaveLength(fixture.usageLimits.shell.approvals)
    expect(designDashboard(fixture, empty).pendingApprovals.local).toHaveLength(0)
    expect(designDashboard(fixture, populated).directory?.links).toHaveLength(fixture.usageLimits.hosts.length - 1)
  })

  it("counts only Claude after Codex sign-in expires and seeds a successful empty local reading", () => {
    const signedOut = readingsFor("sign-in-required").usage.hosts[0]
    if (signedOut?.reading._tag !== "Read") return expect.unreachable()
    expect(new Set(signedOut.reading.usage.tokens.map((entry) => entry.agent))).toEqual(new Set(["claude"]))
    expect(signedOut.reading.usage.tokens.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(142_000_000)
    const empty = readingsFor("empty")
    expect(empty.usage.hosts).toHaveLength(1)
    expect(empty.limits.hosts).toHaveLength(1)
    expect(empty.usage.hosts[0]?.host).toBe(fixture.usageLimits.tokens.host)
    expect(empty.limits.hosts[0]?.host).toBe(fixture.usageLimits.tokens.host)
    expect(empty.usage.hosts[0]?.reading).toMatchObject({ _tag: "Read", skipped: 0, usage: { tokens: [], limits: [] } })
    expect(empty.limits.hosts[0]?.reading).toMatchObject({ _tag: "Read", skipped: 0, limits: { latest: [] } })
  })
})

/** The preload helper re-exported from source, as a build's `font-preload.js` exports it, so no build is needed. */
const preloadHelper = `export * from ${JSON.stringify(new URL("../src/font-preload.ts", import.meta.url).href)}\n`

/** A supplied build holding the preload helper and, unless omitted, every font it names. */
const fixtureBuild = Effect.fn("fixtureBuild")(function*(fonts: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dist = yield* fs.makeTempDirectoryScoped()
  yield* fs.writeFileString(path.join(dist, "font-preload.js"), preloadHelper)
  for (const file of fonts) yield* fs.writeFile(path.join(dist, file), new TextEncoder().encode(`woff2 ${file}`))
  return dist
})

effectIt.layer(NodeServices.layer)("Usage inventory onboarding boundary", (it) => {
  it.effect("uses the supplied build's preload helper and fonts in initial and seeded HTML", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dist = yield* fixtureBuild(PRELOADED_FONTS)
      const fonts = new Map<string, Uint8Array>()
      for (const file of PRELOADED_FONTS) fonts.set(file, yield* fs.readFile(path.join(dist, file)))
      const expected = fontPreloadLink(fonts)
      expect(expected).not.toBe("")
      const preload = yield* usageFontPreload(dist)
      expect(preload).toBe(expected)
      const state = fixture.usageLimits.states.empty
      if (state === undefined) return expect.unreachable()
      const html = dashboardPage(designDashboard(fixture, state), preload)
      const identity = { screen: "usage-limits", state: "empty", viewport: 390, theme: "light" } satisfies Identity
      const seeded = seedDashboardHtml(html, identity)
      if (Result.isFailure(seeded)) return expect.unreachable(seeded.failure.detail)
      for (const page of [html, seeded.success]) {
        for (const file of PRELOADED_FONTS) {
          expect(page.split(`<link rel="preload" href="/assets/${file}" as="font" type="font/woff2" crossorigin>`))
            .toHaveLength(2)
        }
      }
    }).pipe(Effect.scoped))

  it.effect("fails before navigation when the supplied production helper or a required font is missing", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dist = yield* fs.makeTempDirectoryScoped()
      const absent = yield* Effect.result(usageFontPreload(dist))
      if (Result.isSuccess(absent)) return expect.unreachable("Missing production helper accepted")
      expect(absent.failure.detail).toContain(path.join(dist, "font-preload.js"))
      yield* fs.writeFileString(path.join(dist, "font-preload.js"), preloadHelper)
      const missing = yield* Effect.result(usageFontPreload(dist))
      if (Result.isSuccess(missing)) return expect.unreachable("Missing production font accepted")
      expect(missing.failure.detail).toContain(path.join(dist, PRELOADED_FONTS[0] ?? ""))
    }).pipe(Effect.scoped))
  it.effect("borrows the PR inventory only before the product manifest exists", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repository = yield* fs.makeTempDirectoryScoped()
      const selected = yield* usageInventoryFile(repository)
      const packageRoot = yield* path.fromFileUrl(new URL("../", import.meta.url))
      expect(selected).toBe(path.join(packageRoot, "dist/internal/usage-limits-inventory.js"))
    }).pipe(Effect.scoped))

  it.effect("fails with the missing built path for an onboarded product instead of hiding a build or rename failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repository = yield* fs.makeTempDirectoryScoped()
      const refs = path.join(repository, "design-refs/super-app")
      yield* fs.makeDirectory(refs, { recursive: true })
      yield* fs.writeFileString(path.join(refs, "manifest.json"), "{}")
      const result = yield* Effect.result(usageInventoryFile(repository))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "RunnerFailure",
          detail: `Missing built Usage inventory: ${
            path.join(repository, "packages/herdr-hub/dist/internal/usage-limits-inventory.js")
          }`
        })
      }
    }).pipe(Effect.scoped))
})

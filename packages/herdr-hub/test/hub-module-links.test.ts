import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { hubModuleAliases, hubModuleLinkTarget, hubModuleUrl } from "../src/internal/hub-module-links.js"
import {
  connectModule as connect,
  defineModule,
  fleetModule,
  type ModuleDestination,
  todayModule,
  usageModule
} from "../src/module-contract.js"
import { canonicalModuleUrl, readModuleRoute } from "../src/module-navigation.js"

const usage = defineModule({
  ...usageModule,
  pages: usageModule.pages
})
const retiredFleet = defineModule({
  ...fleetModule,
  pages: [{ id: "approvals", label: "Approvals" }, { id: "work", label: "Work" }]
})
const descriptors = [connect, retiredFleet, usage]
const click = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
const home: ModuleDestination<typeof connect> = { module: "connect", page: "overview" }

describe("hub module aliases", () => {
  it("never redirects a routable alias source, including coexisting legacy pages", () => {
    const legacyUsage = defineModule({ ...usage, pages: [...usage.pages, { id: "by-agent", label: "By agent" }] })
    const coexisting = [todayModule, connect, fleetModule, legacyUsage]
    for (const alias of hubModuleAliases) {
      const source = new URL("https://hub.example/")
      if (alias.from._tag === "hash") source.hash = alias.from.value
      else source.searchParams.set("tab", alias.from.value)
      const routable = new URL(source)
      if (alias.from._tag === "tab") routable.hash = `#fleet/${alias.from.value}`
      expect(Result.isSuccess(readModuleRoute(routable, coexisting))).toBe(true)
      expect(hubModuleUrl(source, coexisting).href).toBe(source.href)
    }
  })

  it.each(["#today", "#today/overview", "#fleet/connect", "?tab=connect"])(
    "promotes %s to Connect without dropping its stage target",
    (alias) => {
      const source = new URL(alias, "https://hub.example/")
      source.searchParams.set("host", "ALPHA")
      source.searchParams.set("agent", "agent-1")
      source.searchParams.set("open", "stage")
      const target = hubModuleUrl(source, descriptors)
      expect(target.hash).toBe("#connect/overview")
      expect(target.searchParams.get("tab")).toBeNull()
      expect(target.searchParams.get("host")).toBe("ALPHA")
      expect(target.searchParams.get("agent")).toBe("agent-1")
      expect(target.searchParams.get("open")).toBe("stage")
      expect(source.href).not.toBe(target.href)
    }
  )

  it.each(["#fleet/usage", "?tab=usage", "#usage/by-agent"])(
    "redirects %s only after By tool is installed",
    (alias) => {
      const source = new URL(alias, "https://hub.example/")
      source.searchParams.set("range", "30d")
      source.searchParams.set("timeZone", "Europe/Amsterdam")
      source.searchParams.set("host", "ALPHA")
      const target = hubModuleUrl(source, descriptors)
      expect(target.hash).toBe("#usage/by-tool")
      expect(target.searchParams.get("range")).toBe("30d")
      expect(target.searchParams.get("timeZone")).toBe("Europe/Amsterdam")
      expect(target.searchParams.get("host")).toBe("ALPHA")
      expect(
        hubModuleUrl(source, [
          fleetModule,
          defineModule({ ...usageModule, pages: usageModule.pages.filter((page) => page.id !== "by-tool") })
        ]).href
      ).toBe(source.href)
    }
  )

  it("keeps explicit approval and Work targets ahead of stale legacy tab selectors", () => {
    for (const tab of ["connect", "usage"]) {
      for (const hash of ["#fleet/approvals", "#fleet/work", "#main"]) {
        const source = new URL(
          `https://hub.example/?tab=${tab}&approvalHost=ALPHA&approvalJob=job-9&goal=goal-1${hash}`
        )
        const target = hubModuleUrl(source, descriptors)
        expect(target.href).toBe(source.href)
      }
    }
    const source = new URL("https://hub.example/?tab=approvals&approvalHost=ALPHA&approvalJob=job-9")
    const target = canonicalModuleUrl(hubModuleUrl(source, descriptors), descriptors, home)
    expect(target).toMatchObject({ _tag: "Success" })
    if (Result.isFailure(target)) return expect.unreachable()
    expect(target.success.hash).toBe("#fleet/approvals")
    expect(target.success.searchParams.get("approvalHost")).toBe("ALPHA")
    expect(target.success.searchParams.get("approvalJob")).toBe("job-9")
  })

  it("leaves an unknown Today page invalid rather than turning it into home", () => {
    const source = new URL("https://hub.example/#today/missing")
    const target = hubModuleUrl(source, descriptors)
    expect(target.href).toBe(source.href)
    expect(Result.isFailure(canonicalModuleUrl(target, descriptors, home))).toBe(true)
  })

  it("bridges a blocked-agent push to the current hub document with all selectors", () => {
    const current = new URL("https://hub.example/fleet/#fleet/approvals")
    const target = hubModuleLinkTarget("/connect/?host=ALPHA&agent=agent-1&open=stage", current, click, descriptors)
    if (target === null || Result.isFailure(target)) return expect.unreachable()
    expect(target.success.href).toBe("https://hub.example/fleet/?host=ALPHA&agent=agent-1&open=stage#connect/overview")
  })

  it("retains the standalone Connect bridge until the promoted module is installed", () => {
    const current = new URL("https://hub.example/#fleet/approvals")
    const target = hubModuleLinkTarget("/connect/?agent=agent-1", current, click, [fleetModule])
    if (target === null || Result.isFailure(target)) return expect.unreachable()
    expect(target.success.hash).toBe("#fleet/connect")
  })

  it("leaves external and modified clicks native, including alias links", () => {
    const current = new URL("https://hub.example/#connect")
    expect(hubModuleLinkTarget("https://other.example/connect/?agent=agent-1", current, click, descriptors)).toBeNull()
    for (const field of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      expect(hubModuleLinkTarget("?tab=usage", current, { ...click, [field]: true }, descriptors)).toBeNull()
    }
    expect(hubModuleLinkTarget("#today", current, { ...click, button: 1 }, descriptors)).toBeNull()
  })
})

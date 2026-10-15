/** Recorded long-list identities from the reference export; regression adds three ordinary rows. */
import type { Page } from "@playwright/test"
import { Schema } from "effect"
import { ConnectAgent } from "../../src/model.js"
import { referenceCreatureIdentities } from "../reference-creature-identities.js"

const rows: ReadonlyArray<readonly [name: string, state: string, work: string, host: string, parent?: string]> = [
  ["release-coord", "working", "release-train", "atlas"],
  ["notes-writer", "working", "release-notes", "atlas", "release-coord"],
  ["changelog-check", "idle", "changelog", "atlas", "release-coord"],
  ["build-runner", "working", "nightly-build", "birch"],
  ["cache-warmer", "ready", "build-cache", "birch", "build-runner"],
  ["test-fixer", "working", "flaky-tests", "atlas"],
  ["flake-hunter", "working", "flaky-tests", "atlas", "test-fixer"],
  ["e2e-runner", "idle", "e2e-suite", "atlas", "test-fixer"],
  ["docs-writer", "idle", "docs-refresh", "atlas"],
  ["api-reviewer", "ready", "api-review", "birch"],
  ["schema-check", "done", "schema-diff", "birch", "api-reviewer"],
  ["deps-auditor", "done", "deps-audit", "birch"],
  ["perf-probe", "working", "perf-budget", "atlas"],
  ["bench-runner", "working", "benchmarks", "atlas", "perf-probe"],
  ["bundle-sizer", "idle", "bundle-size", "atlas", "perf-probe"],
  ["a11y-audit", "working", "a11y-pass", "atlas"],
  ["i18n-sweep", "idle", "strings-sweep", "birch"],
  ["log-triage", "ready", "log-triage", "birch"],
  ["ci-doctor", "working", "ci-health", "birch", "log-triage"],
  ["infra-planner", "idle", "infra-plan", "atlas"],
  ["security-scan", "done", "weekly-scan", "birch"],
  ["token-sync", "working", "design-tokens", "atlas"],
  ["story-builder", "idle", "stories", "atlas", "token-sync"],
  ["type-checker", "ready", "strict-types", "atlas"],
  ["copy-editor", "idle", "ui-copy", "birch"]
]

const recorded = (
  name: string,
  state: string,
  work: string,
  host: string,
  at: number,
  parent?: string
): ConnectAgent => {
  const hue = referenceCreatureIdentities.find((entry) => entry.host === host && entry.name === name)?.family
  const fields = {
    id: `agent-${name}`,
    name,
    state,
    work,
    host,
    kind: "claude",
    lastActivityAt: at
  }
  const colored = hue === undefined ? fields : { ...fields, hue }
  return Schema.decodeUnknownSync(ConnectAgent)(
    parent === undefined ? colored : {
      ...colored,
      relationship: { parentAgentId: `agent-${parent}`, relation: "delegated" }
    }
  )
}
const at = (hour: number, minute: number) => Date.UTC(2026, 9, 10, hour, minute)
export const pinReferenceFleet = [
  recorded("sec-cc", "waiting", "sec-cc", "atlas", at(13, 58)),
  {
    ...recorded("pair-codex", "idle", "paired-session", "atlas", at(13, 55)),
    relationship: { parentAgentId: "agent-sec-cc", relation: "pair" }
  },
  recorded("rev-usage", "blocked", "flake-fixes", "birch", at(13, 41)),
  recorded("ds-rly", "working", "design-sync", "atlas", at(14, 2)),
  recorded("skills", "ready", "skills-daily", "atlas", at(11, 47)),
  recorded("pkgsrc", "done", "pkgsrc", "birch", at(12, 10)),
  ...rows.map(([name, state, work, host, parent], index) =>
    recorded(name, state, work, host, at(13, 58 - index * 7), parent)
  )
]
export const pinRegressionFleet = [
  ...pinReferenceFleet,
  ...["fixture-extra-one", "fixture-extra-two", "fixture-extra-three"].map((name) =>
    recorded(name, "working", "package-work", "atlas", at(10, 0))
  )
]

/** Seed the normal device preference before mounting, without replacing the pin component. */
export const seedPins = (page: Page, agents = pinReferenceFleet, names = ["ds-rly", "sec-cc"]) =>
  page.addInitScript(({ agents, names }) => {
    localStorage.setItem(
      "fleet-connect-pins",
      JSON.stringify({
        v: 1,
        pins: names.flatMap((name) =>
          agents.filter((agent) => agent.name === name).map((agent) => ({
            host: agent.host,
            id: agent.id,
            name: agent.name,
            key: `${agent.host}:${agent.id}`,
            seenAt: agent.lastActivityAt
          }))
        )
      })
    )
  }, { agents, names })

/** Use the real embedding's scroll owner, including the page when module regions do not scroll. */
export const scrollPinDirectory = (page: Page, fraction: number) =>
  page.locator(".connect-agents").evaluate((directory, fraction) => {
    for (let node: Element | null = directory; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction
        const box = node.getBoundingClientRect()
        return {
          bottom: Math.min(innerHeight, box.bottom),
          owner: node.className,
          scrollTop: node.scrollTop,
          scrollRange: node.scrollHeight - node.clientHeight
        }
      }
    }
    const node = document.scrollingElement ?? document.documentElement
    window.scrollTo(0, (node.scrollHeight - innerHeight) * fraction)
    return {
      bottom: innerHeight,
      owner: "document",
      scrollTop: node.scrollTop,
      scrollRange: node.scrollHeight - innerHeight
    }
  }, fraction)

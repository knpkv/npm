import type { BodyKind, CreatureHueFamily } from "../src/character.js"

/** Recorded rev6 directory, stage and long-list paint, including the already-allocated hue carried by each fixture. */
export const referenceCreatureIdentities: ReadonlyArray<{
  readonly host: string
  readonly name: string
  readonly bodyKind: BodyKind
  readonly family: CreatureHueFamily
}> = [
  { host: "atlas", name: "sec-cc", bodyKind: "circle", family: "rose" },
  { host: "atlas", name: "pair-codex", bodyKind: "circle", family: "moss" },
  { host: "birch", name: "rev-usage", bodyKind: "squircle", family: "moss" },
  { host: "atlas", name: "ds-rly", bodyKind: "bean", family: "iris" },
  { host: "atlas", name: "skills", bodyKind: "squircle", family: "ember" },
  { host: "birch", name: "pkgsrc", bodyKind: "circle", family: "ember" },
  { host: "atlas", name: "rev-auth", bodyKind: "star", family: "rose" },
  { host: "atlas", name: "release-coord", bodyKind: "squircle", family: "iris" },
  { host: "atlas", name: "notes-writer", bodyKind: "pear", family: "ember" },
  { host: "atlas", name: "changelog-check", bodyKind: "star", family: "teal" },
  { host: "birch", name: "build-runner", bodyKind: "bean", family: "rose" },
  { host: "birch", name: "cache-warmer", bodyKind: "squircle", family: "lime" },
  { host: "atlas", name: "test-fixer", bodyKind: "bean", family: "iris" },
  { host: "atlas", name: "flake-hunter", bodyKind: "squircle", family: "moss" },
  { host: "atlas", name: "e2e-runner", bodyKind: "squircle", family: "teal" },
  { host: "atlas", name: "docs-writer", bodyKind: "squircle", family: "iris" },
  { host: "birch", name: "api-reviewer", bodyKind: "circle", family: "teal" },
  { host: "birch", name: "schema-check", bodyKind: "star", family: "sky" },
  { host: "birch", name: "deps-auditor", bodyKind: "pear", family: "moss" },
  { host: "atlas", name: "perf-probe", bodyKind: "squircle", family: "amber" },
  { host: "atlas", name: "bench-runner", bodyKind: "star", family: "teal" },
  { host: "atlas", name: "bundle-sizer", bodyKind: "bean", family: "amber" },
  { host: "atlas", name: "a11y-audit", bodyKind: "pear", family: "moss" },
  { host: "birch", name: "i18n-sweep", bodyKind: "circle", family: "rose" },
  { host: "birch", name: "log-triage", bodyKind: "squircle", family: "rose" },
  { host: "birch", name: "ci-doctor", bodyKind: "pear", family: "lime" },
  { host: "atlas", name: "infra-planner", bodyKind: "squircle", family: "teal" },
  { host: "birch", name: "security-scan", bodyKind: "circle", family: "lime" },
  { host: "atlas", name: "token-sync", bodyKind: "pear", family: "teal" },
  { host: "atlas", name: "story-builder", bodyKind: "circle", family: "ember" },
  { host: "atlas", name: "type-checker", bodyKind: "pear", family: "moss" },
  { host: "birch", name: "copy-editor", bodyKind: "circle", family: "amber" },
  { host: "birch", name: "lint-fix", bodyKind: "circle", family: "amber" },
  { host: "birch", name: "rev-lint", bodyKind: "star", family: "rose" },
  { host: "atlas", name: "lint-sub", bodyKind: "star", family: "rose" },
  { host: "atlas", name: "fmt-sub", bodyKind: "squircle", family: "amber" }
]

/** 02 Connect, rev6 agentLook: unsigned FNV-1a of the fixture key, then bits 8 upward modulo five. */
export const referenceBodyKind = (host: string, canonicalId: string): BodyKind => {
  let hash = 2166136261
  for (const char of `${host}:${canonicalId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  const kinds: ReadonlyArray<BodyKind> = ["circle", "squircle", "pear", "star", "bean"]
  return kinds[(hash >>> 8) % kinds.length] ?? "circle"
}

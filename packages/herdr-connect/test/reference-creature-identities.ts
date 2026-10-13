import type { BodyKind, CreatureHueFamily } from "../src/character.js"

/** Recorded rev6 2a and A4 paint, including the already-allocated hue carried by each fixture. */
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
  { host: "atlas", name: "skills", bodyKind: "squircle", family: "amber" },
  { host: "birch", name: "pkgsrc", bodyKind: "circle", family: "ember" },
  { host: "atlas", name: "rev-auth", bodyKind: "star", family: "rose" }
]

/** 02 Connect, rev6 agentLook: unsigned FNV-1a of the fixture key, then bits 8 upward modulo five. */
export const referenceBodyKind = (host: string, canonicalId: string): BodyKind => {
  let hash = 2166136261
  for (const char of `${host}:${canonicalId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  const kinds: ReadonlyArray<BodyKind> = ["circle", "squircle", "pear", "star", "bean"]
  return kinds[(hash >>> 8) % kinds.length] ?? "circle"
}

import * as DateTime from "effect/DateTime"

import { stateKey } from "./compare.js"
import type { Failure, Finding, Identity, Manifest, Result, ShotResult, Waiver } from "./schema.js"

export const waiverMatches = (waiver: Waiver, failure: Failure): boolean =>
  waiver.screen === failure.screen && waiver.state === failure.state && waiver.region === failure.region &&
  waiver.rule === failure.rule &&
  (waiver.viewport === undefined || waiver.viewport === failure.viewport) &&
  (waiver.theme === undefined || waiver.theme === failure.theme)

/** Coverage, integrity and stale waivers are always required, even during legacy grace. */
export const verdict = (
  manifest: Manifest,
  failures: ReadonlyArray<Failure>,
  waivers: ReadonlyArray<Waiver>,
  shots: ReadonlyArray<ShotResult>,
  now: DateTime.Utc
): Result => {
  const touched = new Set(shots.filter((shot) => shot.touched).map(stateKey))
  const grace = manifest.enforcement.legacy !== "required" &&
    DateTime.isLessThan(now, manifest.enforcement.legacy.until)
  const findings: Array<Finding> = failures.map((failure) => {
    const waiver = waivers.findIndex((candidate) => waiverMatches(candidate, failure))
    if (waiver !== -1) return { ...failure, disposition: "waived", waiver }
    const required = ["coverage", "integrity", "stale-waiver"].includes(failure.rule) ||
      touched.has(stateKey(failure)) || !grace
    return { ...failure, disposition: required ? "required" : "report-only" }
  })
  for (const waiver of waivers) {
    if (!failures.some((failure) => waiverMatches(waiver, failure))) {
      const identity: Identity = {
        screen: waiver.screen,
        state: waiver.state,
        viewport: waiver.viewport ?? 390,
        theme: waiver.theme ?? "light"
      }
      findings.push({
        ...identity,
        region: waiver.region,
        rule: "stale-waiver",
        detail: `Waiver matches no failure: ${waiver.detail}`,
        disposition: "required"
      })
    }
  }
  return {
    product: manifest.product,
    passed: !findings.some((finding) => finding.disposition === "required"),
    findings,
    shots: shots.map((shot) => ({ ...shot, touched: touched.has(stateKey(shot)) }))
  }
}

import assert from "node:assert/strict"
import { validateReleaseGateEvidence } from "./release-gate-evidence.mjs"

const row = (criterion, status, reviewed, cleanup) => `| ${criterion} | ${status} | ${reviewed} | ${cleanup} |`
const base = [
  ...Array.from({ length: 25 }, (_, index) =>
    row(`SC7.${index + 1}`, "PENDING", "result: PENDING", "cleanup: PENDING")
  ),
  row("Product completion journey", "PENDING", "result: PENDING", "cleanup: PENDING")
].join("\n")

assert.ok(validateReleaseGateEvidence(base).length === 0, "pending evidence is valid outside release mode")
assert.ok(validateReleaseGateEvidence(base, { releaseGate: true }).length > 0, "release mode rejects pending evidence")
assert.ok(
  validateReleaseGateEvidence(`${base}\n${row("SC7.1", "PENDING", "result: PENDING", "cleanup: PENDING")}`).some(
    (failure) => failure.includes("duplicate SC7.1")
  ),
  "duplicate criterion rows are rejected"
)
const canonicalReviewed = `reviewedHead: ${"a".repeat(40)}; commandResult: \`pnpm test\` => PASS; artifact: https://ci.example/run/1; executedAt: 2026-08-02T13:00:00Z; providerIdentity: Jira site knpkv; capabilityStatus: proposal-only; credentialSurface: absent`
const canonicalCleanup = "cleanupResult: complete"
const passingRows = [
  ...Array.from({ length: 25 }, (_, index) => row(`SC7.${index + 1}`, "PASS", canonicalReviewed, canonicalCleanup)),
  row("Product completion journey", "PASS", canonicalReviewed, canonicalCleanup)
]
const passing = passingRows.join("\n")
assert.deepEqual(
  validateReleaseGateEvidence(passing, { releaseGate: true }),
  [],
  "canonical passing evidence is accepted"
)
for (const [label, reviewed, cleanup, expected] of [
  ["reviewedHead", canonicalReviewed.replace("reviewedHead:", "previousRevision:"), canonicalCleanup, "reviewedHead"],
  ["executedAt", canonicalReviewed.replace("executedAt:", "generatedAt:"), canonicalCleanup, "executedAt"],
  [
    "field boundary",
    canonicalReviewed.replace("commandResult:", "previousCommandResult:"),
    canonicalCleanup,
    "commandResult"
  ],
  [
    "commandResult",
    canonicalReviewed.replace("commandResult: `pnpm test` => PASS", "commandResult: "),
    canonicalCleanup,
    "commandResult"
  ],
  [
    "failed command",
    canonicalReviewed.replace("`pnpm test` => PASS", "`pnpm test` => FAIL"),
    canonicalCleanup,
    "commandResult"
  ],
  [
    "artifact",
    canonicalReviewed.replace("artifact: https://ci.example/run/1", "artifact: "),
    canonicalCleanup,
    "artifact or CI link"
  ],
  ["cleanupResult", canonicalReviewed, "cleanupResult: ", "cleanupResult"],
  [
    "secret-bearing artifact",
    canonicalReviewed.replace("https://ci.example/run/1", "https://ci.example/run/1?access_token=redacted"),
    canonicalCleanup,
    "prohibited"
  ],
  [
    "provider locator",
    canonicalReviewed.replace("providerIdentity: Jira site knpkv", "providerIdentity: bucket:private-artifact"),
    canonicalCleanup,
    "prohibited"
  ],
  [
    "providerIdentity",
    canonicalReviewed.replace("providerIdentity: Jira site knpkv; ", ""),
    canonicalCleanup,
    "providerIdentity"
  ],
  [
    "capabilityStatus",
    canonicalReviewed.replace("capabilityStatus: proposal-only; ", ""),
    canonicalCleanup,
    "capabilityStatus"
  ],
  [
    "credentialSurface",
    canonicalReviewed.replace("credentialSurface: absent", "credentialSurface: present"),
    canonicalCleanup,
    "credentialSurface"
  ]
]) {
  const invalid = [...passingRows]
  invalid[0] = row("SC7.1", "PASS", reviewed, cleanup)
  assert.ok(
    validateReleaseGateEvidence(invalid.join("\n"), { releaseGate: true }).some((failure) =>
      failure.includes(expected)
    ),
    `blank ${label} metadata is rejected`
  )
}

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
const passing = [
  ...Array.from({ length: 25 }, (_, index) =>
    row(
      `SC7.${index + 1}`,
      "PASS",
      `reviewedHead: ${"a".repeat(40)}; commandResult: \`pnpm test\` => PASS; artifact: https://ci.example/run/1; executedAt: 2026-08-02T13:00:00Z`,
      "cleanupResult: complete"
    )
  ),
  row(
    "Product completion journey",
    "PASS",
    `reviewedHead: ${"a".repeat(40)}; commandResult: \`pnpm test\` => PASS; artifact: https://ci.example/run/1; executedAt: 2026-08-02T13:00:00Z`,
    "cleanupResult: complete"
  )
].join("\n")
assert.deepEqual(
  validateReleaseGateEvidence(passing, { releaseGate: true }),
  [],
  "canonical passing evidence is accepted"
)

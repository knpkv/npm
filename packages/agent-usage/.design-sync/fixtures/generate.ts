// Regenerates week.json from the stories' fixture week. The fixture builder imports the server's
// store module (SQLite), so previews cannot bundle it; they read this snapshot instead. Run from
// packages/agent-usage after the fixture changes:
//   TZ=UTC pnpm exec tsx .design-sync/fixtures/generate.ts
import { writeFileSync } from "node:fs"
import { buildWeek, type Scenario } from "../../stories/fixtures/week.js"

const scenarios: ReadonlyArray<Scenario> = ["binding", "at-limit", "clear", "empty"]
const weeks = Object.fromEntries(scenarios.map((scenario) => [scenario, buildWeek(scenario)]))
writeFileSync(new URL("./week.json", import.meta.url), `${JSON.stringify(weeks)}\n`)

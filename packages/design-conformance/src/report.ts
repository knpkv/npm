import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

import { shotKey } from "./compare.js"
import { Result } from "./schema.js"

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll(
    "'",
    "&#39;"
  )

const dispositionLabel = (disposition: Result["findings"][number]["disposition"]): string =>
  disposition === "report-only" ? "report-only (inherited/legacy)" : disposition
const tableText = (text: string): string =>
  escapeHtml(text).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ")

/** Report images stay local; all labels and failure details are escaped before entering HTML. */
export const renderReport = (result: Result): string => {
  const sections = result.shots.map((shot) => {
    const findings = result.findings.filter((finding) => shotKey(finding) === shotKey(shot))
    const ordered = [
      "ref",
      "live",
      "diff-frame",
      ...Object.keys(shot.artifacts).filter((label) => label.startsWith("ref-")).sort().flatMap((
        label
      ) => [label, label.replace("ref-", "live-"), label.replace("ref-", "diff-")])
    ]
    const images = ordered.flatMap((label) => {
      const file = shot.artifacts[label]
      return file === undefined
        ? []
        : [
          `<figure><figcaption>${escapeHtml(label)}</figcaption><img src="${escapeHtml(file)}" alt="${
            escapeHtml(label)
          } for ${escapeHtml(shotKey(shot))}" loading="lazy"></figure>`
        ]
    }).join("")
    return `<section><h2>${escapeHtml(shotKey(shot))}</h2><p>${
      shot.touched ? `Touched regions: ${escapeHtml(shot.touchedRegions.join(", "))}` : "Inherited/legacy shot"
    }</p><ul>${
      findings.map((finding) =>
        `<li>${escapeHtml(finding.region)} · ${finding.rule} · ${dispositionLabel(finding.disposition)}: ${
          escapeHtml(finding.detail)
        }</li>`
      ).join("")
    }</ul><div class="shots">${images}</div></section>`
  }).join("")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Design conformance: ${
    escapeHtml(result.product)
  }</title><style>
*{box-sizing:border-box}body{margin:0;padding:1rem;font:1rem/1.5 system-ui;background:oklch(98% 0 none);color:oklch(20% 0 none);text-wrap:pretty;overflow-wrap:break-word}h1,h2,p,figure{margin:0}main{display:grid;gap:2rem}section{display:grid;gap:1rem;border:1px solid oklch(75% 0 none);padding:1rem}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr));gap:1rem}figure{min-inline-size:0}img{display:block;max-inline-size:100%;block-size:auto}figcaption{font-weight:600}
</style></head><body><main><h1>${escapeHtml(result.product)}: ${result.passed ? "PASS" : "FAIL"}</h1><ul>${
    result.findings.map((finding) =>
      `<li>${escapeHtml(shotKey(finding))} / ${escapeHtml(finding.region)} / ${finding.rule} / ${
        dispositionLabel(finding.disposition)
      }: ${escapeHtml(finding.detail)}</li>`
    ).join("")
  }</ul>${sections}</main></body></html>`
}

export const reportSummary = (result: Result): string =>
  [
    `### Design conformance: ${result.product} ${result.passed ? "PASS" : "FAIL"}`,
    "",
    "| State | Region | Rule | Disposition | Drift |",
    "| --- | --- | --- | --- | --- |",
    ...result.findings.map((finding) =>
      `| ${shotKey(finding)} | ${finding.region} | ${finding.rule} | ${dispositionLabel(finding.disposition)} | ${
        tableText(finding.detail)
      } |`
    ),
    "",
    "Report-only findings are inherited/legacy drift. Reference, live and diff images are in the report artifact."
  ].join("\n")

export const writeReport = Effect.fn("DesignConformance.writeReport")(function*(directory: string, result: Result) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const json = yield* Schema.encodeEffect(Schema.fromJsonString(Result))(result)
  yield* fs.writeFileString(path.join(directory, "result.json"), json)
  yield* fs.writeFileString(path.join(directory, "index.html"), renderReport(result))
  yield* fs.writeFileString(path.join(directory, "summary.md"), reportSummary(result))
})

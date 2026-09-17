import { parsePatch } from "@knpkv/rly/diff/patch"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { renderToString } from "react-dom/server"
import { client, css, diagrams } from "./assets.js"
import { escapeHtml } from "./markdown.js"
import type { PatchPrefixes } from "./model.js"
import { emptyFindings, Findings, Guide } from "./model.js"
import { coverageProblems, placeAll } from "./plan.js"
import { GuidePage } from "./view.js"

export class GuideExportError extends Schema.TaggedError<GuideExportError>()("GuideExportError", {
  stage: Schema.Literals(["input", "patch", "coverage", "render"]),
  detail: Schema.String
}) {}

export interface GuideExportInput {
  readonly guide: unknown
  readonly patch: string
  /** Exact custom Git prefixes; omit for default a/b or no-prefix patches. */
  readonly prefixes?: typeof PatchPrefixes.Type
  readonly findings?: unknown
}

/** Validate all inputs and export one offline HTML document. No provider calls or filesystem access. */
export const exportGuide = Effect.fn("Review.exportGuide")(function* (input: GuideExportInput) {
  const guide = yield* Schema.decodeUnknownEffect(Guide)(input.guide).pipe(
    Effect.mapError((error) => new GuideExportError({ stage: "input", detail: String(error) }))
  )
  const findings = yield* Schema.decodeUnknownEffect(Findings)(
    input.findings === undefined ? emptyFindings : input.findings
  ).pipe(Effect.mapError((error) => new GuideExportError({ stage: "input", detail: String(error) })))
  const parsed = parsePatch(input.patch, input.prefixes)
  if (parsed._tag === "PatchInvalid") {
    return yield* new GuideExportError({ stage: "patch", detail: parsed.reason })
  }
  const patch = parsed.patch
  const problems = coverageProblems(guide, patch, findings)
  if (problems.length > 0) return yield* new GuideExportError({ stage: "coverage", detail: problems.join("\n") })
  const placed = placeAll(patch, findings)
  const general = placed.filter((entry) => entry.kind === "general")
  const html = yield* Effect.try({
    try: () => {
      const content = renderToString(<GuidePage guide={guide} patch={patch} findings={findings} />)
      const payload = JSON.stringify({ guide, findings, patch: input.patch, prefixes: input.prefixes }).replaceAll(
        "<",
        "\\u003c"
      )
      const inlineScript = (text: string) => text.replaceAll(/<\/script/gi, "<\\/script")
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(guide.title)}</title><style>${css}</style></head><body><div id="review-root">${content}</div><script id="review-data" type="application/json">${payload}</script><script>${inlineScript(client)}</script>${content.includes('class="mermaid"') ? `<script>${inlineScript(diagrams)}</script>` : ""}</body></html>`
    },
    catch: (cause) => new GuideExportError({ stage: "render", detail: String(cause) })
  })
  return {
    html,
    anchored: placed.length - general.length,
    general,
    chapters: guide.sections.length,
    files: patch.files.length,
    issues: findings.issues.length
  }
})

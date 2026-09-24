import { parsePatch } from "@knpkv/rly/diff/patch"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { renderToString } from "react-dom/server"
import { client, css, diagrams } from "./assets.js"
import { escapeHtml } from "./markdown.js"
import { emptyFindings, Findings, Guide, PatchPrefixes } from "./model.js"
import { coverageProblems, placeAll } from "./plan.js"
import { GuideRoot } from "./root.js"

export class GuideExportError extends Schema.TaggedError<GuideExportError>()("GuideExportError", {
  stage: Schema.Literals(["input", "patch", "coverage", "render"]),
  detail: Schema.String
}) {}

export interface GuideExportInput {
  readonly guide: unknown
  readonly patch: string
  /** Exact producer prefixes; pass two empty strings for --no-prefix to preserve paths resembling a/ and b/. */
  readonly prefixes?: typeof PatchPrefixes.Type
  readonly findings?: unknown
}

/** Export one offline document. All guide fields become client-visible; adapters must omit private locators and credentials. */
export const exportGuide = Effect.fn("Review.exportGuide")(function* (input: GuideExportInput) {
  const guide = yield* Schema.decodeUnknownEffect(Guide)(input.guide).pipe(
    Effect.mapError((error) => new GuideExportError({ stage: "input", detail: String(error) }))
  )
  const findings = yield* Schema.decodeUnknownEffect(Findings)(
    input.findings === undefined ? emptyFindings : input.findings
  ).pipe(Effect.mapError((error) => new GuideExportError({ stage: "input", detail: String(error) })))
  const prefixes =
    input.prefixes === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(PatchPrefixes)(input.prefixes).pipe(
          Effect.mapError((error) => new GuideExportError({ stage: "input", detail: String(error) }))
        )
  const patchText = yield* Schema.decodeUnknownEffect(Schema.String)(input.patch).pipe(
    Effect.mapError((error) => new GuideExportError({ stage: "input", detail: String(error) }))
  )
  const parsed = parsePatch(patchText, prefixes)
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
      const content = renderToString(<GuideRoot guide={guide} patch={patch} findings={findings} />)
      const payload = JSON.stringify({ guide, findings, patch: patchText, prefixes }).replaceAll("<", "\\u003c")
      const inlineScript = (text: string) => text.replaceAll(/<\/script/gi, "<\\/script")
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(guide.title)}</title><style>body{margin:0}${css}</style></head><body><div id="review-root">${content}</div><script id="review-data" type="application/json">${payload}</script><script>${inlineScript(client)}</script>${content.includes('class="mermaid"') ? `<script>${inlineScript(diagrams)}</script>` : ""}</body></html>`
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

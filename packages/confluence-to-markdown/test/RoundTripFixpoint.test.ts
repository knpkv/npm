/**
 * ADF → markdown → ADF fixpoint coverage.
 *
 * The existing `RoundTrip.test.ts` starts from markdown, which is the authoring
 * direction. These start from ADF — the direction `sync pull` + `sync push`
 * actually takes — and assert the structural census is unchanged. A page held
 * in a workspace goes round this loop on every push, so any drift here
 * compounds: the datasource-card duplication that motivated these tests added
 * one extra card per push until someone noticed.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { layer as AdfSchemaValidatorLayer } from "../src/AdfSchemaValidator.js"
import { layer as AtlaskitTransformersLayer } from "../src/AtlaskitTransformers.js"
import { externalizeAdfMetadata, hydrateAdfMetadata } from "../src/internal/adfMetadata.js"
import { adfNodeCensus, roundTripUnsafeNodeTypes, structuralCensusDelta } from "../src/internal/adfNodes.js"
import { layer as MarkdownConverterLayer, MarkdownConverter } from "../src/MarkdownConverter.js"

const TestLayer = MarkdownConverterLayer.pipe(
  Layer.provide(AtlaskitTransformersLayer),
  Layer.provide(AdfSchemaValidatorLayer)
)

const SIDECAR_HREF = "./page.adf.json"

/**
 * One pull/push cycle, including the sidecar externalization the workspace
 * applies on the way to disk and hydration on the way back.
 */
const cycle = <UnparsedInput>(adf: UnparsedInput) =>
  Effect.gen(function*() {
    const converter = yield* MarkdownConverter
    const markdown = yield* converter.adfToMarkdown(JSON.stringify(adf))
    const { markdown: onDisk, sidecar } = externalizeAdfMetadata(markdown, SIDECAR_HREF)
    const sidecars = new Map<string, typeof sidecar & {}>()
    if (sidecar !== null) sidecars.set(SIDECAR_HREF, sidecar)
    const hydrated = hydrateAdfMetadata(onDisk, sidecars)
    const back = yield* converter.markdownToAdf(hydrated)
    const parsed: unknown = JSON.parse(back)
    return parsed
  })

const datasourceExpand = {
  type: "expand",
  attrs: { title: "Issues in this release" },
  marks: [{ type: "breakout", attrs: { mode: "wide", width: 1800 } }],
  content: [
    {
      type: "blockCard",
      attrs: {
        datasource: {
          id: "d8b75300-dfda-4519-b6cd-e49abbd50401",
          parameters: { cloudId: "cloud-1", jql: `fixVersion = "REL 96"` },
          views: [{ type: "table", properties: { columns: [{ key: "key" }, { key: "summary" }] } }]
        },
        url: "https://example.atlassian.net/issues/?jql=fixVersion"
      }
    },
    { type: "paragraph" }
  ]
}

const releaseNotesDoc = {
  type: "doc",
  version: 1,
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Summary" }] },
    { type: "paragraph", content: [{ type: "text", text: "A security-hardening release." }] },
    datasourceExpand
  ]
}

describe("ADF round-trip fixpoint", () => {
  it.effect("preserves the structural census of a datasource expand", () =>
    Effect.gen(function*() {
      const once = yield* cycle(releaseNotesDoc)

      expect(structuralCensusDelta(releaseNotesDoc, once)).toEqual([])
    }).pipe(Effect.provide(TestLayer)))

  // The reported failure only became obvious after several pushes, because each
  // one appended a single extra copy. Two cycles catch a +1-per-cycle drift that
  // a single cycle could mask.
  it.effect("is stable across repeated cycles", () =>
    Effect.gen(function*() {
      const once = yield* cycle(releaseNotesDoc)
      const twice = yield* cycle(once)

      expect(adfNodeCensus(twice)["blockCard"]).toBe(1)
      expect(adfNodeCensus(twice)["expand"]).toBe(1)
      expect(structuralCensusDelta(once, twice)).toEqual([])
    }).pipe(Effect.provide(TestLayer)))

  // Orphaned sidecar entries (ids nothing refers to) were the visible symptom
  // of the duplication: an extra marker in the markdown minted an extra entry.
  // With pairing fixed, every entry must have exactly one referent.
  it.effect("writes no orphaned sidecar entries", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const markdown = yield* converter.adfToMarkdown(JSON.stringify(releaseNotesDoc))
      const { markdown: onDisk, sidecar } = externalizeAdfMetadata(markdown, SIDECAR_HREF)
      const referenced = new Set(
        [...onDisk.matchAll(/ ref=\.\/page\.adf\.json#([A-Za-z0-9-]+) /g)].map(([, id]) => id)
      )

      expect(sidecar).not.toBeNull()
      expect(new Set(Object.keys(sidecar!.entries))).toEqual(referenced)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("keeps the datasource attrs intact", () =>
    Effect.gen(function*() {
      const once = yield* cycle(releaseNotesDoc)

      expect(JSON.stringify(once)).toContain("d8b75300-dfda-4519-b6cd-e49abbd50401")
      expect(JSON.stringify(once)).toContain(`fixVersion = \\"REL 96\\"`)
    }).pipe(Effect.provide(TestLayer)))

  // Macros carry their full attrs in the marker, so they survive the loop and
  // must stay pushable — classifying them unsafe would refuse `sync push` for
  // any page holding a TOC, excerpt or children-display macro.
  it.effect("round-trips ordinary macros without flagging them unsafe", () =>
    Effect.gen(function*() {
      const doc = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "extension",
            attrs: { extensionKey: "toc", extensionType: "com.atlassian.confluence.macro.core", parameters: {} }
          },
          {
            type: "bodiedExtension",
            attrs: { extensionKey: "excerpt", extensionType: "com.atlassian.confluence.macro.core", parameters: {} },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Excerpt body." }] }]
          }
        ]
      }

      const once = yield* cycle(doc)

      expect(roundTripUnsafeNodeTypes(doc)).toEqual([])
      expect(structuralCensusDelta(doc, once)).toEqual([])
    }).pipe(Effect.provide(TestLayer)))

  // Depth counting pairs open markers with close markers. Counting opens only
  // when their payload decodes made the two predicates asymmetric: the inner
  // close was then read as the outer one's, so the outer node came back from
  // its payload *and* the inner markers were reverted again beside it.
  it.effect("pairs nested markers even when the inner payload does not decode", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const outer = JSON.stringify({
        type: "expand",
        attrs: { title: "Outer" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }]
      })
      // Syntactically an open marker, but the payload decodes to a different
      // node type — the shape a corrupted or hand-edited marker takes.
      const markdown = [
        `<!-- adf:expand node=${outer} -->`,
        `<!-- adf:table node={"type":"paragraph"} -->`,
        `<!-- adf:/table -->`,
        `<!-- adf:/expand -->`
      ].join("\n\n")

      const back = JSON.parse(yield* converter.markdownToAdf(markdown))

      expect(adfNodeCensus(back)["expand"]).toBe(1)
      // Nothing leaked through as literal marker text beside the restored node.
      expect(JSON.stringify(back)).not.toContain("adf:table")
      expect(JSON.stringify(back)).not.toContain("adf:/expand")
    }).pipe(Effect.provide(TestLayer)))

  const inCell = <UnparsedInput>(node: UnparsedInput) => ({
    type: "doc",
    version: 1,
    content: [{
      type: "table",
      attrs: { layout: "default" },
      content: [{
        type: "tableRow",
        content: [{ type: "tableCell", attrs: {}, content: [node, { type: "paragraph" }] }]
      }]
    }]
  })

  // A cell renders the card as a bare link, which is what made it look lossy.
  // But the *table* is itself wrapped in `encodedBlockNode`, and that marker
  // carries every descendant verbatim — so the card, datasource and all, comes
  // back whole. Reading the render path alone got this wrong twice.
  it.effect("keeps a datasource card that only a table cell renders as a link", () =>
    Effect.gen(function*() {
      const doc = inCell(datasourceExpand.content[0])

      const once = yield* cycle(doc)

      expect(roundTripUnsafeNodeTypes(doc)).toEqual([])
      expect(adfNodeCensus(once)["blockCard"]).toBe(1)
      expect(JSON.stringify(once)).toContain("d8b75300-dfda-4519-b6cd-e49abbd50401")
    }).pipe(Effect.provide(TestLayer)))

  // The other half of the guard: what the predicate still refuses has to be
  // genuinely unsafe. A bodied macro in a cell does not merely lose its body —
  // the return trip fails outgoing schema validation, so the push guard is the
  // only thing standing between the user and a hard conversion error.
  it.effect("cannot bring a bodied macro in a table cell back", () =>
    Effect.gen(function*() {
      const doc = inCell({
        type: "bodiedExtension",
        attrs: { extensionKey: "excerpt", extensionType: "com.atlassian.confluence.macro.core", parameters: {} },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Excerpt body." }] }]
      })

      const outcome = yield* Effect.exit(cycle(doc))

      expect(roundTripUnsafeNodeTypes(doc)).toEqual(["bodiedExtension"])
      expect(Exit.isFailure(outcome)).toBe(true)
    }).pipe(Effect.provide(TestLayer)))

  // No url means the walker never reaches `encodedBlockNode`: the node becomes
  // an `unsupported ADF node` comment and nothing can rebuild it.
  it.effect("really does lose a card with no url", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const doc = {
        type: "doc",
        version: 1,
        content: [{ type: "blockCard", attrs: { datasource: { id: "orphan" } } }]
      }

      const markdown = yield* converter.adfToMarkdown(JSON.stringify(doc))

      expect(roundTripUnsafeNodeTypes(doc)).toEqual(["blockCard"])
      expect(markdown).toContain("unsupported ADF node: blockCard")
      expect(markdown).not.toContain("orphan")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves a table + task list page", () =>
    Effect.gen(function*() {
      const doc = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "table",
            attrs: { layout: "default" },
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: {},
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Release" }] }]
                  },
                  {
                    type: "tableCell",
                    attrs: {},
                    content: [{ type: "paragraph", content: [{ type: "text", text: "REL 96" }] }]
                  }
                ]
              }
            ]
          },
          {
            type: "taskList",
            attrs: { localId: "list-1" },
            content: [
              {
                type: "taskItem",
                attrs: { localId: "task-1", state: "TODO" },
                content: [{ type: "text", text: "Security impact has been considered." }]
              }
            ]
          }
        ]
      }

      const once = yield* cycle(doc)

      expect(structuralCensusDelta(doc, once)).toEqual([])
    }).pipe(Effect.provide(TestLayer)))
})

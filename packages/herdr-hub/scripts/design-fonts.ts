import { browserCall, type BrowserFailure, type Identity, RunnerFailure } from "@knpkv/design-conformance"
import type { Page } from "@playwright/test"
import { Console, Effect, Result, Schema } from "effect"

const FontUsage = Schema.Struct({
  familyName: Schema.String,
  postScriptName: Schema.String,
  isCustomFont: Schema.Boolean,
  glyphCount: Schema.Natural
})
export const RenderedFontReply = Schema.Struct({ fonts: Schema.Array(FontUsage) })
export interface RenderedFontReply extends Schema.Schema.Type<typeof RenderedFontReply> {}
const DocumentReply = Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Natural }) })
const NodesReply = Schema.Struct({ nodeIds: Schema.Array(Schema.Natural) })
const FontDocument = Schema.Struct({
  epoch: Schema.Natural,
  nodes: Schema.Array(Schema.Struct({
    id: Schema.Natural,
    index: Schema.Natural,
    copy: Schema.String,
    visible: Schema.Boolean,
    mono: Schema.Boolean,
    weight: Schema.String
  }))
})
export interface FontDocument extends Schema.Schema.Type<typeof FontDocument> {}
const ProtocolCause = Schema.Struct({ message: Schema.String })
class FontDocumentChanged extends Schema.TaggedError<FontDocumentChanged>()("FontDocumentChanged", {
  detail: Schema.String
}) {}
class FontTargetMissing extends Schema.TaggedError<FontTargetMissing>()("FontTargetMissing", {
  detail: Schema.String
}) {}

interface FontDocumentGuard {
  readonly snapshot: () => FontDocument
  readonly disconnect: () => void
}

// Literal browser source avoids host-only helpers injected by tsx into nested callbacks.
const fontDocumentGuardScript = String.raw`(() => {
  let epoch = 0;
  let nextId = 1;
  const ids = new WeakMap();
  const observer = new MutationObserver(() => { epoch += 1; });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  return {
    snapshot() {
      if (observer.takeRecords().length > 0) epoch += 1;
      const nodes = Array.from(document.querySelectorAll("body *"), (element, index) => {
        if (!ids.has(element)) ids.set(element, nextId++);
        const copy = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent ?? "").join("").trim();
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { id: ids.get(element), index, copy,
          visible: copy.length > 0 && box.width > 1 && box.height > 1 &&
            element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
          mono: style.fontFamily.includes("Mono"), weight: style.fontWeight };
      });
      return { epoch, nodes };
    },
    disconnect() { observer.disconnect(); }
  };
})()`

interface FontInspection {
  readonly currentNodes: () => Effect.Effect<ReadonlyArray<number>, BrowserFailure | RunnerFailure>
  readonly fonts: (nodeId: number) => Effect.Effect<RenderedFontReply, BrowserFailure | RunnerFailure>
}

interface FontDocumentInspection extends FontInspection {
  readonly snapshot: () => Effect.Effect<FontDocument, BrowserFailure | RunnerFailure>
  readonly invalidationEpoch: () => number
}

const sameFontDocument = (left: FontDocument, right: FontDocument) =>
  left.epoch === right.epoch && JSON.stringify(left.nodes) === JSON.stringify(right.nodes)

/** A render invalidates the whole proof. Retry only observed churn, never a font mismatch or unrelated SDK error. */
export const inspectFontDocument = Effect.fn("SuperappDesign.inspectFontDocument")(
  function*(inspection: FontDocumentInspection, identity: Identity) {
    const before = yield* inspection.snapshot()
    const invalidation = inspection.invalidationEpoch()
    if (!before.nodes.some((item) => item.visible)) {
      return yield* new RunnerFailure({ detail: `Empty font document ${JSON.stringify(identity)}` })
    }
    const changed = Effect.fn("SuperappDesign.fontDocumentChanged")(function*() {
      const after = yield* inspection.snapshot()
      return invalidation !== inspection.invalidationEpoch() || !sameFontDocument(before, after)
    })
    const attempt = Effect.gen(function*() {
      const evidence: Array<
        { readonly copy: string; readonly weight: string; readonly fonts: ReadonlyArray<typeof FontUsage.Type> }
      > = []
      for (const item of before.nodes.filter((item) => item.visible)) {
        const decoded = yield* inspectCurrentFont(inspection, identity, item.index, before.nodes.length, item.copy)
        const fonts = yield* Effect.fromResult(renderedFontUsage(identity, item.copy, item.mono, decoded))
        evidence.push({ copy: item.copy, weight: item.weight, fonts })
      }
      if (yield* changed()) {
        return yield* new FontDocumentChanged({
          detail: `DOM changed during font inspection ${JSON.stringify(identity)}`
        })
      }
      return evidence
    })
    return yield* attempt.pipe(
      Effect.catchTag("FontTargetMissing", (error) =>
        Effect.gen(function*() {
          if (yield* changed()) return yield* new FontDocumentChanged({ detail: error.detail })
          return yield* new RunnerFailure({ detail: error.detail })
        })),
      Effect.catchTag("BrowserFailure", (error) =>
        Effect.gen(function*() {
          const cause = Schema.decodeUnknownResult(ProtocolCause)(error.cause)
          if (
            error.operation === "inspect rendered Usage font" && Result.isSuccess(cause) &&
            cause.success.message.endsWith(
              "Protocol error (CSS.getPlatformFontsForNode): Could not find node with given id"
            ) &&
            (yield* changed())
          ) {
            return yield* new FontDocumentChanged({ detail: `${JSON.stringify(identity)}: ${cause.success.message}` })
          }
          return yield* error
        }))
    )
  },
  (effect, _inspection, identity) =>
    effect.pipe(
      Effect.retry({ times: 2, while: (error) => error._tag === "FontDocumentChanged" }),
      Effect.timeout("5 seconds"),
      Effect.catchTag("FontDocumentChanged", (error) =>
        Effect.fail(
          new RunnerFailure({
            detail: `Font document unstable after 3 attempts ${JSON.stringify(identity)}: ${error.detail}`
          })
        )),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new RunnerFailure({ detail: `Font inspection exceeded 5 seconds ${JSON.stringify(identity)}` })))
    )
)

/** Resolve each target in the current document immediately before inspecting its glyphs. */
export const inspectCurrentFont = Effect.fn("SuperappDesign.inspectCurrentFont")(
  function*(inspection: FontInspection, identity: Identity, index: number, expectedCount: number, copy: string) {
    const nodes = yield* inspection.currentNodes()
    const nodeId = nodes[index]
    if (nodes.length !== expectedCount || nodeId === undefined) {
      return yield* new FontTargetMissing({ detail: `Unstable font target ${JSON.stringify(identity)} ${copy}` })
    }
    return yield* inspection.fonts(nodeId)
  }
)

/** Validate actual rendered glyphs, not the CSS family list or the font loading promise. */
export const renderedFontUsage = (identity: Identity, label: string, mono: boolean, reply: RenderedFontReply) => {
  const expected = mono ? "Geist Mono" : "Geist"
  const prefix = mono ? "GeistMono-" : "Geist-"
  const fonts = reply.fonts.filter((font) => font.glyphCount > 0)
  if (
    fonts.length === 0 ||
    fonts.some((font) => !font.isCustomFont || font.familyName !== expected || !font.postScriptName.startsWith(prefix))
  ) {
    return Result.fail(
      new RunnerFailure({
        detail: `Rendered font mismatch ${JSON.stringify(identity)} ${label}: expected custom ${expected}; actual ${
          JSON.stringify(reply.fonts)
        }`
      })
    )
  }
  return Result.succeed(fonts)
}

/** Chromium reports the face used for each visible direct text node; both supplied apps must pass before capture. */
export const assertUsageFonts = Effect.fn("SuperappDesign.assertUsageFonts")(
  function*(page: Page, identity: Identity) {
    yield* browserCall("wait for Usage fonts", () => page.evaluate(() => document.fonts.ready).then(() => undefined))
    const session = yield* Effect.acquireRelease(
      browserCall("open Usage font inspection", () => page.context().newCDPSession(page)),
      (session) => browserCall("close Usage font inspection", () => session.detach()).pipe(Effect.orDie)
    )
    yield* browserCall("enable Usage font inspection", async () => {
      await session.send("DOM.enable")
      await session.send("CSS.enable")
    })
    let invalidation = 0
    const invalidate = () => {
      invalidation += 1
    }
    yield* Effect.acquireRelease(
      browserCall("observe Usage document invalidation", async () => session.on("DOM.documentUpdated", invalidate)),
      () =>
        browserCall("stop Usage document invalidation", async () => session.off("DOM.documentUpdated", invalidate))
          .pipe(Effect.orDie)
    )
    const guard = yield* Effect.acquireRelease(
      browserCall("observe Usage font DOM", () => page.evaluateHandle<FontDocumentGuard>(fontDocumentGuardScript)),
      (guard) =>
        browserCall("stop Usage font DOM observation", async () => {
          try {
            await guard.evaluate((value) => value.disconnect())
          } finally {
            await guard.dispose()
          }
        }).pipe(Effect.orDie)
    )
    const inspection: FontDocumentInspection = {
      invalidationEpoch: () => invalidation,
      snapshot: Effect.fn("SuperappDesign.fontDocumentSnapshot")(function*() {
        const snapshot: unknown = yield* browserCall(
          "snapshot Usage font document",
          () => guard.evaluate((value) => value.snapshot())
        )
        return yield* Schema.decodeUnknownEffect(FontDocument)(snapshot).pipe(
          Effect.mapError((cause) =>
            new RunnerFailure({ detail: `Invalid font snapshot ${JSON.stringify(identity)}: ${cause.message}` })
          )
        )
      }),
      currentNodes: Effect.fn("SuperappDesign.currentFontNodes")(function*() {
        const documentReply: unknown = yield* browserCall(
          "inspect Usage document",
          () => session.send("DOM.getDocument")
        )
        const root = yield* Schema.decodeUnknownEffect(DocumentReply)(documentReply).pipe(
          Effect.mapError((cause) =>
            new RunnerFailure({ detail: `Invalid font document ${JSON.stringify(identity)}: ${cause}` })
          )
        )
        const reply: unknown = yield* browserCall(
          "inspect current Usage text nodes",
          () => session.send("DOM.querySelectorAll", { nodeId: root.root.nodeId, selector: "body *" })
        )
        const nodes = yield* Schema.decodeUnknownEffect(NodesReply)(reply).pipe(
          Effect.mapError((cause) =>
            new RunnerFailure({ detail: `Invalid font nodes ${JSON.stringify(identity)}: ${cause}` })
          )
        )
        return nodes.nodeIds
      }),
      fonts: Effect.fn("SuperappDesign.currentRenderedFont")(function*(nodeId: number) {
        const usage: unknown = yield* browserCall(
          "inspect rendered Usage font",
          () => session.send("CSS.getPlatformFontsForNode", { nodeId })
        )
        return yield* Schema.decodeUnknownEffect(RenderedFontReply)(usage).pipe(
          Effect.mapError((cause) =>
            new RunnerFailure({
              detail: `Invalid rendered font evidence ${JSON.stringify(identity)}: ${cause.message}`
            })
          )
        )
      })
    }
    const evidence = yield* inspectFontDocument(inspection, identity)
    yield* Console.log(`Usage rendered fonts ${JSON.stringify({ identity, evidence })}`)
    return evidence
  },
  Effect.scoped
)

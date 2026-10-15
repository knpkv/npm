import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import { CodeReviewResult } from "@knpkv/codecommit-web/host"
import { parseReviewDiffFile, reviewWorkspaceThreads } from "@knpkv/codecommit-web/views"
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { Fixture } from "../../../design-conformance/src/schema.js"
import { fontPreloadLink } from "../../src/font-preload.js"
import { dashboardPage } from "../../src/internal/dashboard-page.js"
import { renderCaptureDocument, resolveFixtureRead } from "./adapter.js"
import { CODE_REFERENCE, makeCodeReadings, makeReviewContents, makeReviewFixture } from "./fixtures.js"
import { ReviewState } from "./inventory.js"

const loadFixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* path.fromFileUrl(new URL("../../../../design-refs/code-review/fixture.json", import.meta.url))
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Fixture))(yield* fs.readFileString(file))
})

const loadCorrectedFixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* path.fromFileUrl(
    new URL("../../../../design-refs/code-review/revisions/export-25/fixture.json", import.meta.url)
  )
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Fixture))(yield* fs.readFileString(file))
})

it.layer(NodeServices.layer)("Code fixture projections", (it) => {
  it.effect("preloads served shell fonts before CSS without advertising an absent face", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const { snapshot } = makeCodeReadings(fixture.data)
      const faces = ["geist-latin-wght-normal.woff2", "geist-mono-latin-wght-normal.woff2"]
      for (const names of [faces, faces.slice(0, 1)]) {
        const fonts = new Map(names.map((name) => [name, new Uint8Array([1])]))
        const html = renderCaptureDocument(snapshot, fonts, { dashboardPage }, { fontPreloadLink })
        for (const name of faces) {
          const link = `<link rel="preload" href="/assets/${name}" as="font" type="font/woff2" crossorigin>`
          if (names.includes(name)) {
            expect(html).toContain(link)
            expect(html.indexOf(link)).toBeLessThan(html.indexOf("<link rel=\"stylesheet\""))
          } else {
            expect(html).not.toContain(link)
          }
        }
      }
    }))

  it.effect("retains the recorded head while the actual current diff moves to the approved new head", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const reading = makeReviewFixture(fixture.data, "different-revision-findings-head")
      expect(reading._tag).toBe("Ready")
      if (reading._tag !== "Ready") return
      expect(reading.reading.diff.headCommit).toBe("e7f8a9b")
      expect(reading.reading.workspace.identity.headRevision).toBe("e7f8a9b")
      expect(reading.reading.workspace.run).toMatchObject({
        _tag: "Ready",
        run: { identity: { headRevision: "a1b2c3d" }, threads: { length: 9 } }
      })
    }))

  it.effect("separates the saved agent summary, finding discussions and incomplete history from human conversations", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const summary = makeReviewFixture(fixture.data, "conversation-agent-summary")
      expect(summary._tag).toBe("Ready")
      if (summary._tag !== "Ready") return
      expect(summary.reading.workspace.run).toMatchObject({
        _tag: "Ready",
        run: {
          summary: "The draft key can restore another agent’s text, and reconnect retries have no upper bound.",
          threads: []
        }
      })
      expect(summary.reading.workspace.conversations).toMatchObject({ _tag: "Ready", threads: { length: 2 } })
      const finding = makeReviewFixture(fixture.data, "conversation-finding-discussion")
      expect(finding._tag).toBe("Ready")
      if (finding._tag !== "Ready") return
      expect(finding.reading.workspace.run).toMatchObject({
        _tag: "Ready",
        run: {
          threads: [
            { id: "F1", messages: [{ author: "PR author" }, { author: "Reviewer" }] },
            { id: "F2", messages: [] }
          ]
        }
      })
      expect(finding.reading.workspace.conversations).toMatchObject({ _tag: "Ready", threads: { length: 1 } })
      const incomplete = makeReviewFixture(fixture.data, "conversation-incomplete")
      expect(incomplete._tag).toBe("Ready")
      if (incomplete._tag !== "Ready") return
      expect(incomplete.reading.workspace.run).toEqual({ _tag: "Unavailable", reason: "io" })
      expect(incomplete.reading.workspace.conversations).toMatchObject({ _tag: "Ready", threads: { length: 2 } })
    }))

  it.effect("keeps a deleted comment's recorded author/time and live replies without inventing removed text", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const reading = makeReviewFixture(fixture.data, "deleted-comment")
      expect(reading._tag).toBe("Ready")
      if (reading._tag !== "Ready") return
      expect(reading.reading.workspace.conversations).toMatchObject({
        _tag: "Ready",
        threads: [{
          messages: [
            { author: "Reviewer", deleted: true, text: "", createdAt: Date.parse("2026-10-11T13:40:00.000Z") },
            { author: "PR author", deleted: false, text: "Moved the retry banner text into copy/stage.ts." },
            { author: "Second reviewer", deleted: false, text: "Thanks, that reads better." }
          ]
        }]
      })
    }))

  it.effect("preserves recorded optional finding fields and P4 without adding an interpretation", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const reading = makeReviewFixture(fixture.data, "recorded-extra-fields")
      expect(reading._tag).toBe("Ready")
      if (reading._tag !== "Ready" || reading.reading.workspace.run._tag !== "Ready") return
      const { threads } = reading.reading.workspace.run.run
      expect(threads).toHaveLength(2)
      expect(threads[0]?.finding).toMatchObject({
        axis: "Security",
        confidence: "high",
        requirement: "A draft restores only into the agent and stage it was written for.",
        summary: "The reconnect test restores coord’s draft into the ds-rly stage.",
        patch: { path: "web/src/stage/useDraft.ts", headRevision: "a1b2c3d" }
      })
      expect(threads[1]?.finding).toMatchObject({ severity: "P4", axis: "Standards", confidence: "low" })
    }))

  it.effect("keeps an Explain record as its saved prose without inventing review findings or a verdict", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const reading = makeReviewFixture(fixture.data, "recorded-explain")
      expect(reading._tag).toBe("Ready")
      if (reading._tag !== "Ready") return
      expect(reading.reading.workspace.run).toMatchObject({
        _tag: "Ready",
        run: { kind: "explain", summary: "", threads: [], profile: { kind: "explain" } }
      })
      if (reading.reading.workspace.run._tag !== "Ready") return
      expect(reading.reading.workspace.run.run.explanation).toContain(
        "There are no changes to the hub or to the message format."
      )
    }))

  it.effect("keeps base-only revision mismatches distinct and never supplies missing findings to a clean run", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const base = makeReviewFixture(fixture.data, "different-revision-findings-base")
      expect(base._tag).toBe("Ready")
      if (base._tag !== "Ready") return
      expect(base.reading.diff.headCommit).toBe("a1b2c3d")
      expect(base.reading.workspace.identity.baseRevision).toBe("fixture-current-base")
      expect(base.reading.workspace.run).toMatchObject({
        _tag: "Ready",
        run: { identity: { baseRevision: "fixture-base", headRevision: "a1b2c3d" } }
      })
      const clean = makeReviewFixture(fixture.data, "different-revision-no-findings")
      expect(clean._tag).toBe("Ready")
      if (clean._tag !== "Ready") return
      expect(clean.reading.workspace.run).toMatchObject({ _tag: "Ready", run: { threads: [] } })
      expect(clean.reading.workspace.conversations).toMatchObject({ _tag: "Ready", threads: [] })
      expect(clean.reading.workspace.identity.headRevision).toBe("e7f8a9b")
      expect(clean.reading.workspace.run).toMatchObject({
        _tag: "Ready",
        run: { identity: { headRevision: "a1b2c3d" } }
      })
    }))

  it.effect("projects the authoritative legacy fixture into a real decoded saved review", () =>
    Effect.gen(function*() {
      const fixture = yield* loadFixture
      const reading = Schema.decodeUnknownSync(CodeReviewResult)(makeReviewFixture(fixture.data))
      expect(reading._tag).toBe("Ready")
      if (reading._tag !== "Ready") return
      expect(reading.reading.workspace.run).toMatchObject({
        _tag: "Ready",
        run: {
          summary: "The draft key can restore another agent’s text, and reconnect retries have no upper bound.",
          profile: { name: "sec-cc", harness: "native-claude", model: "Opus" }
        }
      })
      expect(reading.reading.workspace.run._tag === "Ready" ? reading.reading.workspace.run.run.threads : [])
        .toHaveLength(9)
      expect(reading.reading.diff.files).toHaveLength(3)
      expect(reading.reading.workspace.conversations).toMatchObject({
        _tag: "Ready",
        threads: [
          { id: "T1", messages: [{ author: "Mira" }, { author: "Ellis" }] },
          { id: "T3", messages: [{ author: "Jonas" }] }
        ]
      })
    }))

  it.effect("serves only its opaque subject and exact immutable content selectors", () =>
    Effect.gen(function*() {
      const fixture = yield* loadFixture
      const readings = makeCodeReadings(fixture.data)
      for (const route of ["detail", "review"]) {
        const url = new URL(`http://127.0.0.1/v1/modules/code/${route}?ref=${CODE_REFERENCE}`)
        expect(resolveFixtureRead(readings, url)).toHaveProperty("_tag", "Ready")
        url.searchParams.set("ref", "00000000-0000-4000-8000-000000000452")
        expect(resolveFixtureRead(readings, url)).toBeUndefined()
      }
      const url = new URL("http://127.0.0.1/v1/modules/code/diff-content")
      url.search = new URLSearchParams({
        ref: CODE_REFERENCE,
        revisionId: "recorded-revision",
        baseCommit: "fixture-base",
        headCommit: "a1b2c3d",
        fileIndex: "0"
      }).toString()
      expect(resolveFixtureRead(readings, url)).toMatchObject({ _tag: "Ready", content: { fileIndex: 0 } })
      for (const key of ["ref", "revisionId", "baseCommit", "headCommit", "fileIndex"]) {
        const changed = new URL(url)
        changed.searchParams.set(key, "foreign")
        expect(resolveFixtureRead(readings, changed), key).toBeUndefined()
      }
      url.searchParams.set("fileIndex", "999")
      expect(resolveFixtureRead(readings, url)).toBeUndefined()
    }))

  it.effect("keeps the reference shell counts instead of inventing an empty fleet", () =>
    Effect.gen(function*() {
      const fixture = yield* loadFixture
      const inputs = makeCodeReadings(fixture.data)
      expect(inputs.snapshot.host).toBe("atlas")
      expect(inputs.snapshot.directory?.links).toHaveLength(2)
      expect(inputs.snapshot.pendingApprovals.local).toHaveLength(3)
      expect(makeReviewContents(fixture.data)).toHaveLength(3)
    }))

  it.effect("feeds every file through the actual framed parser and rejects foreign revision content", () =>
    Effect.gen(function*() {
      const fixture = yield* loadFixture
      const reading = makeReviewFixture(fixture.data)
      const contents = makeReviewContents(fixture.data)
      expect(reading._tag).toBe("Ready")
      if (reading._tag !== "Ready") return
      for (const file of reading.reading.diff.files) {
        const content = contents[file.index]
        expect(content?._tag).toBe("Ready")
        if (content?._tag !== "Ready") continue
        const parsed = parseReviewDiffFile(file, reading.reading.diff.revisionId, content.content)
        expect(Result.isSuccess(parsed), file.path).toBe(true)
        if (Result.isSuccess(parsed)) {
          expect(parsed.success.path).toBe(file.path)
          expect(parsed.success.hunks.length).toBeGreaterThan(0)
          expect(parsed.success.hunks.flatMap(({ lines }) => lines).some(({ kind }) => kind === "add")).toBe(true)
        }
        const stale = parseReviewDiffFile(file, "another-revision", content.content)
        expect(stale).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ReviewDiffFileError", reason: "wrong_content" }
        })
      }
    }))

  it.effect("keeps absent review history and independently unavailable comments distinct", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const missing = makeReviewFixture(fixture.data, "review-not-recorded-readonly")
      expect(missing).toMatchObject({
        _tag: "Ready",
        reading: {
          workspace: {
            run: { _tag: "NotRecorded" },
            conversations: { _tag: "Ready", threads: { length: 2 } }
          }
        }
      })
      for (
        const [state, reason] of [
          ["review-run-unavailable-no-comments", "not_cached"],
          ["review-run-unavailable-comments-over-limit", "over_limit"],
          ["review-run-unavailable-comments-corrupt", "corrupt"]
        ] satisfies ReadonlyArray<readonly [ReviewState, string]>
      ) {
        expect(makeReviewFixture(fixture.data, state)).toMatchObject({
          _tag: "Ready",
          reading: {
            workspace: {
              run: { _tag: "Unavailable", reason: "io" },
              conversations: { _tag: "Unavailable", reason }
            }
          }
        })
      }
      expect(makeReviewFixture(fixture.data, "comments-only-unavailable")).toMatchObject({
        _tag: "Ready",
        reading: { workspace: { run: { _tag: "Ready" }, conversations: { _tag: "Unavailable", reason: "not_cached" } } }
      })
    }))

  it.effect("drives saved fixed, dismissed and resolved dispositions without adding command authority", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const fixed = makeReviewFixture(fixture.data, "review-fix-pushed-readonly")
      expect(fixed._tag).toBe("Ready")
      if (fixed._tag !== "Ready" || fixed.reading.workspace.run._tag !== "Ready") return
      expect(fixed.reading.workspace.run.run.threads.find(({ id }) => id === "F1")?.finding?.disposition)
        .toEqual({ _tag: "FixedVerify", commit: "d4e5f6a" })
      const dismissed = makeReviewFixture(fixture.data, "review-dismissed-readonly")
      expect(dismissed._tag).toBe("Ready")
      if (dismissed._tag !== "Ready" || dismissed.reading.workspace.run._tag !== "Ready") return
      expect(dismissed.reading.workspace.run.run.threads.find(({ id }) => id === "F4")?.finding?.disposition)
        .toMatchObject({ _tag: "Dismissed", reason: "false_positive" })
      const resolved = makeReviewFixture(fixture.data, "review-resolved-readonly")
      expect(resolved._tag).toBe("Ready")
      if (resolved._tag !== "Ready" || resolved.reading.workspace.run._tag !== "Ready") return
      expect(resolved.reading.workspace.run.run.threads.find(({ id }) => id === "F5"))
        .toMatchObject({ resolved: true, finding: { disposition: { _tag: "Resolved" } } })
    }))

  it.effect("refuses conflicting snapshot thread identities instead of manufacturing an empty thread list", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const reading = makeReviewFixture(fixture.data, "review-threads-conflict")
      expect(reading._tag).toBe("Ready")
      if (reading._tag !== "Ready") return
      expect(reviewWorkspaceThreads(reading.reading.workspace)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ThreadsConflict" }
      })
    }))

  it.effect("feeds a decoded invalid mode through the real parser and keeps unavailable files typed", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const readings = makeCodeReadings(fixture.data, "diff-rejected")
      expect(readings.review._tag).toBe("Ready")
      if (readings.review._tag !== "Ready") return
      const file = readings.review.reading.diff.files[0]
      const content = readings.contents[0]
      expect(file).toBeDefined()
      expect(content?._tag).toBe("Ready")
      if (file === undefined || content?._tag !== "Ready") return
      expect(parseReviewDiffFile(file, readings.review.reading.diff.revisionId, content.content))
        .toMatchObject({ _tag: "Failure", failure: { reason: "invalid_patch" } })
      expect(makeCodeReadings(fixture.data, "diff-unavailable").contents[0])
        .toEqual({ _tag: "Unavailable", reason: "unavailable", host: null })
    }))

  it.effect("keeps queue, detail and review on the same unavailable owner boundary", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const readings = makeCodeReadings(fixture.data, "code-owner-unavailable")
      for (const route of ["queue", "detail", "review"]) {
        const url = new URL(`http://127.0.0.1/v1/modules/code/${route}`)
        url.search = route === "queue"
          ? "filter=open&search=&offset=0"
          : new URLSearchParams({ ref: CODE_REFERENCE }).toString()
        expect(resolveFixtureRead(readings, url), route)
          .toEqual({ _tag: "Unavailable", reason: "other_host", host: "build-host" })
      }
    }))

  it.effect("projects every declared reachable state through the actual public boundary schemas", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      for (const state of ReviewState.literals) {
        const inputs = makeCodeReadings(fixture.data, state)
        expect(Schema.is(CodeReviewResult)(inputs.review), state).toBe(true)
        expect(inputs.detail._tag, state).toBe(state === "code-owner-unavailable" ? "Unavailable" : "Ready")
        if (inputs.review._tag !== "Ready") continue
        for (const file of inputs.review.reading.diff.files) {
          expect(inputs.contents[file.index], state).toBeDefined()
        }
      }
    }))
})

it.layer(NodeServices.layer)("read-only reference records", (it) => {
  it.effect("preserves all recorded findings while conversations show only recorded messages and roles", () =>
    Effect.gen(function*() {
      const fixture = yield* loadCorrectedFixture
      const reading = makeReviewFixture(fixture.data, "review-conversation-readonly")
      expect(reading._tag).toBe("Ready")
      if (reading._tag !== "Ready" || reading.reading.workspace.run._tag !== "Ready") return
      expect(reading.reading.workspace.run.run.threads).toHaveLength(9)
      const discussions = reviewWorkspaceThreads(reading.reading.workspace)
      expect(discussions._tag).toBe("Success")
      if (discussions._tag !== "Success") return
      expect(discussions.success.conversations).toHaveLength(2)
      expect(discussions.success.conversations.flatMap(({ messages }) => messages.map(({ author }) => author)))
        .toEqual(["Reviewer", "PR author", "Second reviewer"])
      expect(reading.reading.workspace.run.run.threads.filter(({ messages }) => messages.length > 0))
        .toMatchObject([{ id: "F1", messages: [{ author: "PR author" }] }])
    }))
})

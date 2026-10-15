/** Code selectors carry opaque references only. Repairs belong exclusively to the active page. @module */
import {
  type CodeQueueQuery,
  CodeQueueSelection,
  CodeReference,
  CodeReviewPresentation,
  CodeReviewThreadTarget
} from "@knpkv/codecommit-web/host"
import { Result, Schema } from "effect"

const FileIndex = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 999 }))
const fields = CodeQueueSelection.fields
const EncodedThread = Schema.String.check(Schema.isMaxLength(2_048))
const Query = Schema.fromURLSearchParams(
  Schema.Struct({
    ...fields,
    ref: Schema.optionalKey(CodeReference),
    file: Schema.optionalKey(FileIndex),
    view: Schema.optionalKey(CodeReviewPresentation),
    thread: Schema.optionalKey(EncodedThread)
  })
)
const Filter = Schema.fromURLSearchParams(Schema.Struct({ filter: fields.filter }))
const Search = Schema.fromURLSearchParams(Schema.Struct({ search: fields.search }))
const Offset = Schema.fromURLSearchParams(Schema.Struct({ offset: fields.offset }))
const Target = Schema.fromURLSearchParams(Schema.Struct({ ref: Schema.optionalKey(CodeReference) }))
const File = Schema.fromURLSearchParams(Schema.Struct({ file: Schema.optionalKey(FileIndex) }))
const View = Schema.fromURLSearchParams(Schema.Struct({ view: Schema.optionalKey(CodeReviewPresentation) }))
const Thread = Schema.fromURLSearchParams(Schema.Struct({ thread: Schema.optionalKey(EncodedThread) }))
const decodeThread = Schema.decodeUnknownResult(Schema.fromJsonString(CodeReviewThreadTarget), {
  onExcessProperty: "error"
})

export interface CodeSelection extends CodeQueueQuery {
  readonly ref: CodeReference | null
  readonly file: number | null
  readonly view: Exclude<CodeReviewPresentation, "guide">
  readonly thread: CodeReviewThreadTarget | null
}

/** Serialize only this page's normalized selectors; review state requires an opaque PR reference. */
export const codeSelectionSearch = (selection: CodeSelection): URLSearchParams => {
  const canonical = new URLSearchParams({
    filter: selection.filter,
    search: selection.search,
    offset: String(selection.offset)
  })
  if (selection.ref !== null) {
    canonical.set("ref", selection.ref)
    if (selection.file !== null) canonical.set("file", String(selection.file))
    if (selection.view !== "review") canonical.set("view", selection.view)
    if (selection.thread !== null) {
      canonical.set("thread", JSON.stringify({ source: selection.thread.source, id: selection.thread.id }))
    }
  }
  return canonical
}

/** Native links and ordinary activation share one PR transition; only the same subject keeps its review selectors. */
export const codeSelectionForReference = (selection: CodeSelection, ref: CodeReference): CodeSelection =>
  selection.ref === ref
    ? { ...selection, file: null }
    : { ...selection, ref, file: null, view: "review", thread: null }

/** Keep valid fields during repair. Reviews always means cached approvals waiting, never personal requests. */
export const canonicalCodeSelection = (search: URLSearchParams, page: "pull-requests" | "reviews" | "diffs") => {
  const decoded = Schema.decodeUnknownResult(Query, { onExcessProperty: "error" })(search)
  const filter = Schema.decodeUnknownResult(Filter)(search)
  const text = Schema.decodeUnknownResult(Search)(search)
  const offset = Schema.decodeUnknownResult(Offset)(search)
  const target = Schema.decodeUnknownResult(Target)(search)
  const file = Schema.decodeUnknownResult(File)(search)
  const view = Schema.decodeUnknownResult(View)(search)
  const encodedThread = Schema.decodeUnknownResult(Thread)(search)
  const thread = Result.flatMap(
    encodedThread,
    (value) => value.thread === undefined ? Result.succeed(null) : decodeThread(value.thread)
  )
  const ref = Result.isSuccess(target) ? target.success.ref ?? null : null
  // Guide has no host reader in P2. Recognize old links only to replace them with Review.
  const guide = Result.isSuccess(view) && view.success.view === "guide"
  const selection: CodeSelection = {
    filter: page === "reviews" ? "reviews" : Result.isSuccess(filter) ? filter.success.filter : "open",
    search: Result.isSuccess(text) ? text.success.search : "",
    offset: Result.isSuccess(offset) ? offset.success.offset : 0,
    ref,
    file: ref !== null && Result.isSuccess(file) ? file.success.file ?? null : null,
    view: ref !== null && Result.isSuccess(view) && view.success.view !== "guide"
      ? view.success.view ?? "review"
      : "review",
    thread: ref !== null && !guide && Result.isSuccess(thread) ? thread.success : null
  }
  const canonical = codeSelectionSearch(selection)
  return {
    selection,
    search: canonical,
    repaired: guide || Result.isFailure(decoded) || Result.isFailure(thread) ||
      (page === "reviews" && search.has("filter") && search.get("filter") !== "reviews") ||
      (search.has("file") && selection.file === null) ||
      (ref === null && (search.has("view") || search.has("thread")))
  }
}

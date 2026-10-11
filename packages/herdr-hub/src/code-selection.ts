/** Code selectors carry opaque references only. Repairs belong exclusively to the active page. @module */
import { type CodeQueueQuery, CodeQueueSelection, CodeReference } from "@knpkv/codecommit-web/host"
import { Result, Schema } from "effect"

const FileIndex = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 999 }))
const fields = CodeQueueSelection.fields
const Query = Schema.fromURLSearchParams(
  Schema.Struct({ ...fields, ref: Schema.optionalKey(CodeReference), file: Schema.optionalKey(FileIndex) })
)
const Filter = Schema.fromURLSearchParams(Schema.Struct({ filter: fields.filter }))
const Search = Schema.fromURLSearchParams(Schema.Struct({ search: fields.search }))
const Offset = Schema.fromURLSearchParams(Schema.Struct({ offset: fields.offset }))
const Target = Schema.fromURLSearchParams(Schema.Struct({ ref: Schema.optionalKey(CodeReference) }))
const File = Schema.fromURLSearchParams(Schema.Struct({ file: Schema.optionalKey(FileIndex) }))

export interface CodeSelection extends CodeQueueQuery {
  readonly ref: CodeReference | null
  readonly file: number | null
}

/** Keep valid fields during repair. Reviews always means cached approvals waiting, never personal requests. */
export const canonicalCodeSelection = (search: URLSearchParams, page: "pull-requests" | "reviews" | "diffs") => {
  const decoded = Schema.decodeUnknownResult(Query, { onExcessProperty: "error" })(search)
  const filter = Schema.decodeUnknownResult(Filter)(search)
  const text = Schema.decodeUnknownResult(Search)(search)
  const offset = Schema.decodeUnknownResult(Offset)(search)
  const target = Schema.decodeUnknownResult(Target)(search)
  const file = Schema.decodeUnknownResult(File)(search)
  const ref = Result.isSuccess(target) ? target.success.ref ?? null : null
  const selection: CodeSelection = {
    filter: page === "reviews" ? "reviews" : Result.isSuccess(filter) ? filter.success.filter : "open",
    search: Result.isSuccess(text) ? text.success.search : "",
    offset: Result.isSuccess(offset) ? offset.success.offset : 0,
    ref,
    file: page === "diffs" && ref !== null && Result.isSuccess(file) ? file.success.file ?? null : null
  }
  const canonical = new URLSearchParams({
    filter: selection.filter,
    search: selection.search,
    offset: String(selection.offset)
  })
  if (ref !== null) canonical.set("ref", ref)
  if (selection.file !== null) canonical.set("file", String(selection.file))
  return {
    selection,
    search: canonical,
    repaired: Result.isFailure(decoded) ||
      (page === "reviews" && search.has("filter") && search.get("filter") !== "reviews") ||
      (search.has("file") && selection.file === null)
  }
}

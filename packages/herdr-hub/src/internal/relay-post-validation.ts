import { ConnectPostBody, ConnectPostRequest, connectPostTextLimit, InvalidReport } from "@knpkv/herdr-connect"
import { Effect, Schema, SchemaIssue } from "effect"

const postTextBound = Schema.makeFilter(({ kind, text }: Pick<ConnectPostBody, "kind" | "text">) => {
  if (text.trim().length === 0) return { path: ["text"], issue: "is empty" }
  const limit = kind === "status" ? connectPostTextLimit.status : connectPostTextLimit.other
  return text.length > limit
    ? {
      path: ["text"],
      issue: `is ${text.length} characters; ${kind} posts are limited to ${limit}${
        kind === "status" ? ` (other kinds ${connectPostTextLimit.other})` : ""
      }`
    }
    : undefined
})
const PostBodyTextPrecheck = Schema.Struct({ ...ConnectPostBody.fields, text: Schema.String }).check(postTextBound)
const PostRequestTextPrecheck = Schema.Struct({ ...ConnectPostRequest.fields, text: Schema.String }).check(
  postTextBound
)

const invalidReport = (error: Schema.SchemaError): InvalidReport =>
  new InvalidReport({
    detail: SchemaIssue.makeFormatterStandardSchemaV1({
      leafHook: (issue) => issue._tag === "UnexpectedKey" ? "is unexpected" : SchemaIssue.defaultLeafHook(issue)
    })(error.issue).issues
      .map(({ message, path }) => `${path?.map(String).join(".") || "post"} ${message}`)
      .join("; ")
  })

/** Precheck text for precise CLI diagnostics, then let the published schema validate the post. */
export const decodeRelayPostBody = Effect.fn("Relay.decodePostBody")(
  Schema.decodeUnknownEffect(PostBodyTextPrecheck),
  Effect.flatMap(Schema.decodeUnknownEffect(ConnectPostBody)),
  Effect.mapError(invalidReport)
)

/** Precheck HTTP text, then validate the published request, rejecting excess fields at both steps. */
export const decodeRelayPostRequest = Effect.fn("Relay.decodePostRequest")(
  Schema.decodeUnknownEffect(PostRequestTextPrecheck, { onExcessProperty: "error" }),
  Effect.flatMap(Schema.decodeUnknownEffect(ConnectPostRequest, { onExcessProperty: "error" })),
  Effect.mapError(invalidReport)
)

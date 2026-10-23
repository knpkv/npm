import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

/** A request body's fields: JSON values for JSON protocols, strings for query protocols. */
const Fields = Schema.Record(Schema.String, Schema.Json)
type Fields = typeof Fields.Type

/** One request as AWS saw it: the host, the operation (JSON target or query Action) and the body. */
export interface SeenCall {
  readonly host: string
  readonly operation: string
  readonly body: Fields
  readonly authorization: string
}

/** What a fake answers: a JSON body for JSON protocols, an XML document for query protocols. */
export type FakeAnswer =
  | { readonly _tag: "Json"; readonly status: number; readonly body: Schema.Json; readonly errorType?: string }
  | { readonly _tag: "Xml"; readonly status: number; readonly body: string }

export const json = (body: Schema.Json, status = 200, errorType?: string): FakeAnswer =>
  errorType === undefined ? { _tag: "Json", status, body } : { _tag: "Json", status, body, errorType }

export const xml = (body: string, status = 200): FakeAnswer => ({ _tag: "Xml", status, body })

const parse = (text: string, contentType: string | undefined): Fields =>
  contentType?.includes("x-www-form-urlencoded") === true
    ? Object.fromEntries(new URLSearchParams(text))
    : text === ""
    ? {}
    : Schema.decodeUnknownSync(Schema.fromJsonString(Fields))(text)

/**
 * An AWS that answers each call through `answer` and records it in `seen`. JSON-protocol operations are
 * named by the part of `x-amz-target` after the dot, query-protocol ones by their `Action`.
 */
export const fakeAws = (answer: (call: SeenCall) => FakeAnswer, seen: Array<SeenCall> = []) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      const body = parse(text, request.headers["content-type"])
      const target = request.headers["x-amz-target"]
      const operation = target === undefined ? String(body["Action"]) : target.slice(target.indexOf(".") + 1)
      const call = {
        host: new URL(request.url).host,
        operation,
        body,
        authorization: request.headers["authorization"] ?? ""
      }
      seen.push(call)
      const reply = answer(call)
      const headers = new Headers({ "content-type": reply._tag === "Xml" ? "text/xml" : "application/x-amz-json-1.1" })
      if (reply._tag === "Json" && reply.errorType !== undefined) headers.set("x-amzn-errortype", reply.errorType)
      const payload = reply._tag === "Xml" ? reply.body : JSON.stringify(reply.body)
      return HttpClientResponse.fromWeb(request, new Response(payload, { status: reply.status, headers }))
    })
  )

/** Runs `effect` against `client` as AWS. */
export const against = (client: HttpClient.HttpClient) => Effect.provideService(HttpClient.HttpClient, client)

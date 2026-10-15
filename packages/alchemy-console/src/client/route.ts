import { Option, Schema } from "effect"
import { StackId } from "../api.js"
import { ResourceFqn } from "../schema.js"
import type { StackTab } from "../views.js"

const RouteFields = Schema.Struct({
  stack: StackId,
  resource: Schema.optionalKey(ResourceFqn),
  tab: Schema.optionalKey(Schema.Literals(["resources", "outputs", "state", "plan"]))
})

/** URLs retain only normalized authenticated identifiers. No backend paths, provider selectors or bootstrap fragment. */
export type ConsoleRoute = { readonly _tag: "List" } | {
  readonly _tag: "Stack"
  readonly id: StackId
  readonly resource: string | null
  readonly tab: StackTab
}

interface RouteQueryFields {
  stack: string | null
  resource?: string | null
  tab?: string | null
}

export const readRoute = (search: string): ConsoleRoute => {
  if (search.length > 4096) return { _tag: "List" }
  const params = new URLSearchParams(search)
  if (["stack", "resource", "tab"].some((key) => params.getAll(key).length > 1)) return { _tag: "List" }
  const input: RouteQueryFields = { stack: params.get("stack") }
  if (params.has("resource")) input.resource = params.get("resource")
  if (params.has("tab")) input.tab = params.get("tab")
  const fields = Option.getOrNull(Schema.decodeUnknownOption(RouteFields)(input))
  return fields === null ? { _tag: "List" } : {
    _tag: "Stack",
    id: fields.stack,
    resource: fields.resource ?? null,
    tab: fields.tab ?? "resources"
  }
}

export const routeHref = (route: ConsoleRoute): string => {
  if (route._tag === "List") return "/"
  const params = new URLSearchParams({ stack: route.id })
  if (route.resource !== null) params.set("resource", route.resource)
  if (route.tab !== "resources") params.set("tab", route.tab)
  return `/?${params.toString()}`
}

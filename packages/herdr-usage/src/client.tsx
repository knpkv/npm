/**
 * The Usage app's client: {@link UsagePage} in the app's own React root, given a {@link UsageShell} made from the
 * {@link ShellContext} its shell passes (the hub's superapp or hub-app's standalone shell). Bundled to
 * `dist/client/client.js`.
 *
 * Reads go to the app's own routes (`ctx.api("/limits")`, `ctx.api("/usage")`), with the shell's request headers.
 *
 * @module
 */
import { FleetLimits, FleetReadLoadError, FleetUsage, type Received, type UsageQuery } from "@knpkv/herdr-connect/usage"
import { defineAppClient, type ShellContext } from "@knpkv/hub-app"
import { Icon } from "@knpkv/rly/foundations"
import { Clock, Effect, Exit, ManagedRuntime, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { type ReactElement, useMemo } from "react"
import { createRoot } from "react-dom/client"
import { usageChrome, usageHref } from "./shell.js"
import { type UsageModuleReads, UsagePage, UsagePageId, type UsageShell } from "./views.js"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)

/** One read of an app route, stamped with when this page received it. */
const load = Effect.fn("UsageClient.load")(function* <A>(
  context: ShellContext,
  path: `/${string}`,
  schema: Schema.Codec<A, unknown, never, never>
) {
  const url = context.api(path)
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .execute(
      HttpClientRequest.get(new URL(url, window.location.href)).pipe(
        HttpClientRequest.setHeaders(context.requestHeaders())
      )
    )
    .pipe(Effect.mapError((cause) => new FleetReadLoadError({ path: url, reason: "network", cause })))
  if (response.status < 200 || response.status >= 300) {
    return yield* new FleetReadLoadError({ path: url, reason: "status", cause: response.status })
  }
  const fleet = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((cause) => new FleetReadLoadError({ path: url, reason: "decode", cause }))
  )
  return { fleet, receivedAt: yield* Clock.currentTimeMillis } satisfies Received<A>
})

/** Run a read on this page's runtime; unmounting or leaving the page aborts its request. */
const onRuntime = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Effect.Effect<A, E> =>
  Effect.callback((resume, signal) => {
    runtime.runCallback(effect, {
      signal,
      onExit: (exit) => resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))
    })
  })

const UsageApp = ({ context }: { readonly context: ShellContext }): ReactElement => {
  const reads = useMemo(
    (): UsageModuleReads => ({
      limits: onRuntime(load(context, "/limits", FleetLimits)),
      usage: (query: UsageQuery) =>
        onRuntime(
          load(
            context,
            `/usage?${new URLSearchParams({ range: query.range, timeZone: query.timeZone }).toString()}`,
            FleetUsage
          )
        )
    }),
    [context.api, context.requestHeaders]
  )
  const shell = useMemo(
    (): UsageShell => ({
      active: context.active,
      navigate: (href) => context.navigate(href, "replace", null),
      href: usageHref(context),
      // The shell's grouped header, when it has one; standalone it has none, so no chrome.
      chrome: usageChrome(context),
      nextIcon: <Icon name="chevron-right" decorative />
    }),
    [context]
  )
  const page = Option.getOrElse(Schema.decodeUnknownOption(UsagePageId)(context.page), (): UsagePageId => "limits")
  return (
    <UsagePage
      content={{
        host: context.host ?? context.caller.login,
        reads,
        viewerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        now: Date.now(),
        onHubMachine: false
      }}
      shell={shell}
      page={page}
      search={context.search}
    />
  )
}

export default defineAppClient({
  contract: 1,
  mount: (root, context) => {
    const react = createRoot(root)
    react.render(<UsageApp context={context} />)
    return {
      update: (next) => react.render(<UsageApp context={next} />),
      unmount: () => react.unmount()
    }
  }
})

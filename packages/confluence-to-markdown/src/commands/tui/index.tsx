/**
 * TUI command - unified interactive interface for Confluence.
 */
import { Command } from "@effect/cli"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { ConfluenceAuth } from "../../ConfluenceAuth.js"
import type { ThemeName } from "./themes/index.js"
import { AUTH_MENU_ITEMS, TuiApp } from "./TuiApp.js"
import type { TuiItem } from "./TuiItem.js"
import { TuiService } from "./TuiService.js"
import { BrowseSettings, BrowseSettingsLive } from "./TuiSettings.js"

/**
 * Single TUI run - returns "reload" to signal restart.
 */
const runTuiOnce = Effect.gen(function* () {
  const service = yield* TuiService
  const settings = yield* BrowseSettings
  const auth = yield* ConfluenceAuth

  // Get user info if authenticated
  const user = yield* auth.getCurrentUser().pipe(Effect.catchAll(() => Effect.succeed(null)))

  // Get initial items based on mode
  let initialItems: ReadonlyArray<TuiItem>
  const userEmail: string | null = user ? (user.name ? `${user.name} <${user.email}>` : user.email) : null

  if (service.mode.type === "unauthenticated") {
    initialItems = AUTH_MENU_ITEMS
    yield* Console.log("Not authenticated - showing login options...")
  } else if (service.mode.type === "authenticated") {
    yield* Console.log(`Authenticated as ${user?.name ?? "user"} - loading spaces...`)
    initialItems = yield* service.getSpaces.pipe(Effect.tapError((e) => Console.error(`Error loading spaces: ${e}`)))
    yield* Console.log(`Loaded ${initialItems.length} spaces`)
  } else {
    yield* Console.log(`Loading pages from ${service.siteName}...`)
    const rootItem = yield* service.getRootItem
    initialItems = [rootItem]
  }

  const currentSettings = yield* settings.get
  let currentTheme = currentSettings.theme
  const onThemeChange = (theme: ThemeName) => {
    currentTheme = theme
    Effect.runPromise(settings.setTheme(theme))
  }

  // Create renderer
  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        targetFps: 60,
        exitOnCtrlC: false,
        useKittyKeyboard: {}
      })
    ),
    (r) =>
      Effect.sync(() => {
        r.stop()
        r.destroy()
      })
  )

  const root = createRoot(renderer)
  let shouldReload = false

  // Wait for quit signal
  yield* Effect.async<void>((resume) => {
    root.render(
      <TuiApp
        service={service}
        initialItems={initialItems}
        userEmail={userEmail}
        onQuit={() => resume(Effect.void)}
        initialTheme={currentTheme}
        onThemeChange={onThemeChange}
        onModeChange={() => {
          shouldReload = true
          resume(Effect.void)
        }}
      />
    )
    renderer.start()
  })

  root.unmount()

  if (shouldReload) {
    yield* Console.log("\nReloading...")
    return yield* Effect.fail("reload" as const)
  }

  yield* Console.log("\nGoodbye!")
}).pipe(Effect.scoped)

/**
 * TUI command - adapts based on auth/config state.
 */
export const tuiCommand = Command.make("tui", {}, () =>
  runTuiOnce.pipe(
    // Retry on reload (up to 10 times to prevent infinite loop)
    Effect.retry(
      Schedule.recurWhile((e): e is "reload" => e === "reload").pipe(Schedule.intersect(Schedule.recurs(10)))
    )
  )
).pipe(Command.withDescription("Interactive TUI for Confluence (adapts to auth/config state)"))

export { BrowseSettingsLive as TuiSettingsLive }

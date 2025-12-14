/**
 * Browse command - interactive TUI for navigating Confluence pages.
 */
import { Command } from "@effect/cli"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ConfluenceAuth } from "../../ConfluenceAuth.js"
import { BrowseApp } from "./BrowseApp.js"
import { BrowseService, BrowseServiceLive } from "./BrowseService.js"
import { BrowseSettings, BrowseSettingsLive } from "./BrowseSettings.js"
import type { ThemeName } from "./themes/index.js"

/**
 * Browse command - interactive TUI.
 */
export const browseCommand = Command.make("browse", {}, () =>
  Effect.gen(function* () {
    const service = yield* BrowseService
    const auth = yield* ConfluenceAuth
    const settings = yield* BrowseSettings

    // Get current user, root item, and settings
    const [user, rootItem, currentSettings] = yield* Effect.all([
      auth.getCurrentUser(),
      service.getRootItem,
      settings.get
    ])

    // Theme change handler
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

    // Wait for quit signal
    yield* Effect.async<void>((resume) => {
      root.render(
        <BrowseApp
          service={service}
          initialItem={rootItem}
          userEmail={user?.email ?? null}
          onQuit={() => resume(Effect.void)}
          initialTheme={currentTheme}
          onThemeChange={onThemeChange}
        />
      )
      renderer.start()
    })

    root.unmount()
    yield* Console.log("\nGoodbye!")
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(BrowseServiceLive, BrowseSettingsLive)))
).pipe(Command.withDescription("Browse Confluence pages interactively (TUI)"))

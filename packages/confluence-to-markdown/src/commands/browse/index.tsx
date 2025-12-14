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
import type { BrowseItem } from "./BrowseItem.js"
import { BrowseService, BrowseServiceLive, BrowseServiceSpacesLive } from "./BrowseService.js"
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

    // Get current user and settings
    const [user, currentSettings] = yield* Effect.all([auth.getCurrentUser(), settings.get])

    // Get initial items based on mode
    let initialItems: ReadonlyArray<BrowseItem>
    if (service.mode === "spaces") {
      // Spaces mode - get all spaces
      initialItems = yield* service.getSpaces
    } else {
      // Configured mode - get root item
      const rootItem = yield* service.getRootItem
      initialItems = [rootItem]
    }

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
          initialItems={initialItems}
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

/**
 * Browse spaces command - no config needed, just auth.
 */
export const browseSpacesCommand = Command.make("browse-spaces", {}, () =>
  Effect.gen(function* () {
    const service = yield* BrowseService
    const auth = yield* ConfluenceAuth
    const settings = yield* BrowseSettings

    yield* Console.log("Loading spaces...")
    const [user, currentSettings, initialItems] = yield* Effect.all([
      auth.getCurrentUser(),
      settings.get,
      service.getSpaces.pipe(Effect.tapError((e) => Console.error(`Error loading spaces: ${e}`)))
    ])
    yield* Console.log(`Loaded ${initialItems.length} spaces`)

    let currentTheme = currentSettings.theme
    const onThemeChange = (theme: ThemeName) => {
      currentTheme = theme
      Effect.runPromise(settings.setTheme(theme))
    }

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

    yield* Effect.async<void>((resume) => {
      root.render(
        <BrowseApp
          service={service}
          initialItems={initialItems}
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
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(BrowseServiceSpacesLive, BrowseSettingsLive)))
).pipe(Command.withDescription("Browse all Confluence spaces (no config needed)"))

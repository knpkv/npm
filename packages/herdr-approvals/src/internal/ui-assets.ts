/**
 * The browser app's files, read from hostd's install directory.
 *
 * The scripts, the stylesheet and its fonts are read once at startup: hostd can't serve the app without
 * them. The PNG icons are read per request, so a missing one answers 404 and never stops hostd.
 *
 * @module
 */
import { Console, Effect, FileSystem, Path } from "effect"
import type { UiAssets } from "../http.js"
import { relayIconAssets } from "../relay-icon.js"

/** Loads the app from `directory`, where the build put `index.css`, the scripts, the fonts and the icons. */
export const loadUiAssets = Effect.fn("Hostd.loadUiAssets")(function*(directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const stylesheet = yield* fileSystem.readFileString(paths.join(directory, "index.css"))
  const fontNames = new Set(
    [...stylesheet.matchAll(/url\(["']?\.\/([^"')]+\.woff2)/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]]
    )
  )
  const fonts = yield* Effect.forEach(
    [...fontNames],
    (name) =>
      fileSystem.readFile(paths.join(directory, name)).pipe(
        Effect.map((contents): readonly [string, Uint8Array] => [name, contents])
      )
  )
  const iconFiles = new Set(relayIconAssets.map(({ file }) => file))
  const run = Effect.runPromiseWith(yield* Effect.context<never>())
  // Read per request, so a missing or unreadable PNG answers 404 and never stops hostd: the manifest's
  // SVG icon covers it, and the install can be repaired without a restart.
  const icon = (file: string): Promise<Uint8Array | null> =>
    iconFiles.has(file)
      ? run(
        fileSystem.readFile(paths.join(directory, file)).pipe(
          Effect.catch((error) =>
            Console.warn(`hostd: icon ${file} is unavailable, answering 404: ${error.message}`).pipe(Effect.as(null))
          )
        )
      )
      : Promise.resolve(null)
  return {
    connectScript: yield* fileSystem.readFileString(paths.join(directory, "connect.js")),
    fonts: new Map(fonts),
    icon,
    script: yield* fileSystem.readFileString(paths.join(directory, "approval.js")),
    stylesheet,
    worker: yield* fileSystem.readFileString(paths.join(directory, "approval-sw.js"))
  } satisfies UiAssets
})

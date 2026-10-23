/**
 * The standalone shell's stylesheet cache. The page links `/app/shell.css?v=<hash of its text>`; the server reads
 * the built file until one read succeeds (a build that lands after start is picked up), and lets browsers keep the
 * text for good only when asked for under that hash.
 *
 * @module
 */
import { Effect, Option, Ref } from "effect"

/** `load` until it succeeds once, then its value without running it again. A failure is not kept. */
export const cacheSuccess = <A, E, R>(load: Effect.Effect<A, E, R>) =>
  Ref.make(Option.none<A>()).pipe(
    Effect.map((kept) =>
      Ref.get(kept).pipe(
        Effect.flatMap(Option.match({
          onSome: Effect.succeed,
          onNone: () => load.pipe(Effect.tap((value) => Ref.set(kept, Option.some(value))))
        }))
      )
    )
  )

/** `immutable` only for the current hash: an older page's URL gets today's text, which must not be kept under it. */
export const shellCssCacheControl = (requested: string | undefined, current: string): string =>
  requested === current ? "public, max-age=31536000, immutable" : "no-cache"

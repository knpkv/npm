import { it } from "@effect/vitest"
import { platform } from "node:os"

/**
 * Darwin's `/dev/fd` exposes descriptor identity but not descriptor-relative
 * child traversal. Publication therefore fails closed there until a native
 * `openat`/`linkat`/`renameat` adapter is available. Linux CI runs these tests.
 */
export const descriptorIt = {
  effect: platform() === "darwin" ? it.effect.skip : it.effect
} satisfies { readonly effect: typeof it.effect.skip }

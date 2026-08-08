import type { Stream } from "effect"
import type * as FileSystem from "effect/FileSystem"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { streamEvents } from "../src/index.js"

type Requirements<Value> = Value extends Stream.Stream<unknown, unknown, infer Requirement> ? Requirement : never
type Includes<Whole, Part> = Part extends Whole ? true : false

const _ordinary = streamEvents({ cwd: "/workspace", prompt: "review" })
const _promptOnly = streamEvents({ cwd: "/workspace", prompt: "review", promptOnly: true })
declare const widenedPromptOnly: boolean
const _widened = streamEvents({ cwd: "/workspace", prompt: "review", promptOnly: widenedPromptOnly })

export const ordinaryNeedsSpawner: Includes<
  Requirements<typeof _ordinary>,
  ChildProcessSpawner.ChildProcessSpawner
> = true
// @ts-expect-error ordinary streams must not acquire a FileSystem requirement
export const ordinaryNeedsFileSystem: Includes<Requirements<typeof _ordinary>, FileSystem.FileSystem> = true
export const promptOnlyNeedsSpawner: Includes<
  Requirements<typeof _promptOnly>,
  ChildProcessSpawner.ChildProcessSpawner
> = true
export const promptOnlyNeedsFileSystem: Includes<Requirements<typeof _promptOnly>, FileSystem.FileSystem> = true
export const widenedNeedsSpawner: Includes<
  Requirements<typeof _widened>,
  ChildProcessSpawner.ChildProcessSpawner
> = true
export const widenedNeedsFileSystem: Includes<Requirements<typeof _widened>, FileSystem.FileSystem> = true

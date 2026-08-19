import type { FileSystem } from "effect"
import * as Predicate from "effect/Predicate"

/** Reads the Node platform descriptor intentionally hidden by Effect's portable File interface. */
export const nodeFileDescriptor = (file: FileSystem.File): number | undefined => {
  if (!("fd" in file)) return undefined
  return Predicate.isNumber(file.fd) ? file.fd : undefined
}

/** Preserves a Node descriptor when a test or adapter decorates a portable File handle. */
export const preserveNodeFileDescriptor = (
  source: FileSystem.File,
  decorated: FileSystem.File
): FileSystem.File => {
  const descriptor = nodeFileDescriptor(source)
  return descriptor === undefined ? decorated : Object.assign(decorated, { fd: descriptor })
}

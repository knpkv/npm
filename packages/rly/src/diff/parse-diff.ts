import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs"
import type { RlyDiffCodeItem } from "./types.js"

const requireText = (value: string, field: string): string => {
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`)
  return value
}

export const validateDiffCodeItem = (item: RlyDiffCodeItem): void => {
  requireText(item.id, "Diff item id")
  requireText(item.before.name, `Diff item ${item.id} before name`)
  requireText(item.after.name, `Diff item ${item.id} after name`)
  if (item.version !== undefined && (!Number.isInteger(item.version) || item.version < 0)) {
    throw new Error(`Diff item ${item.id} version must be a non-negative integer`)
  }
}

/** Parse one validated rly before/after item into the pinned renderer's metadata shape. */
export const parseDiffFilePair = (item: RlyDiffCodeItem): FileDiffMetadata => {
  validateDiffCodeItem(item)
  return parseDiffFromFile(
    {
      ...(item.before.cacheKey === undefined ? {} : { cacheKey: item.before.cacheKey }),
      contents: item.before.contents,
      name: item.before.name
    },
    {
      ...(item.after.cacheKey === undefined ? {} : { cacheKey: item.after.cacheKey }),
      contents: item.after.contents,
      name: item.after.name
    },
    undefined,
    true
  )
}

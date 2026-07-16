import type { Path } from "effect"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import type { BlobDigest } from "./BlobDigest.js"

/** Derived path shape. It is kept inside the server persistence boundary. */
export interface BlobPath {
  readonly workspaceDirectory: string
  readonly objectDirectory: string
  readonly file: string
}

/** Derives the partitioned object path from already-decoded identity values. */
export const blobPath = (
  path: Path.Path,
  canonicalRoot: string,
  workspaceId: WorkspaceId,
  digest: BlobDigest
): BlobPath => {
  const workspaceDirectory = path.join(canonicalRoot, "objects", workspaceId)
  const objectDirectory = path.join(
    workspaceDirectory,
    "sha256",
    digest.slice(0, 2),
    digest.slice(2, 4)
  )

  return {
    workspaceDirectory,
    objectDirectory,
    file: path.join(objectDirectory, digest)
  }
}

import { Schema } from "effect"

import { WorkspaceId } from "../../../domain/identifiers.js"
import { BlobDigest } from "./BlobDigest.js"

/** Whether bytes are authoritative evidence or a safely regenerable cache. */
export const BlobClassification = Schema.Literals(["durable", "reproducible-cache"])

/** Decoded blob durability classification. */
export type BlobClassification = typeof BlobClassification.Type

/** Workspace-scoped reference persisted by repository metadata. */
export class BlobRef extends Schema.Class<BlobRef>("BlobRef")({
  workspaceId: WorkspaceId,
  digest: BlobDigest,
  sizeBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  classification: BlobClassification
}) {}

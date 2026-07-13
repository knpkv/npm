import { Schema } from "effect"

import { BlobDigest } from "./BlobDigest.js"

/** A blob reference or read option did not satisfy the storage contract. */
export class BlobStoreInputError extends Schema.TaggedErrorClass<BlobStoreInputError>()("BlobStoreInputError", {
  operation: Schema.String,
  message: Schema.String
}) {}

/** The requested blob does not exist in the selected workspace. */
export class BlobNotFoundError extends Schema.TaggedErrorClass<BlobNotFoundError>()("BlobNotFoundError", {
  digest: BlobDigest
}) {}

/** A blob exceeded the operation's configured byte bound. */
export class BlobTooLargeError extends Schema.TaggedErrorClass<BlobTooLargeError>()("BlobTooLargeError", {
  digest: Schema.Union([BlobDigest, Schema.Null]),
  actualBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  maximumBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
}) {}

/** An opened blob ended before the exact requested byte count was read. */
export class BlobUnexpectedEofError extends Schema.TaggedErrorClass<BlobUnexpectedEofError>()(
  "BlobUnexpectedEofError",
  {
    operation: Schema.String,
    expectedBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    actualBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  }
) {}

/** Stored bytes no longer match their content address. */
export class BlobIntegrityError extends Schema.TaggedErrorClass<BlobIntegrityError>()("BlobIntegrityError", {
  expectedDigest: BlobDigest,
  actualDigest: BlobDigest
}) {}

/** A path escaped the owner-only object root or crossed a symbolic link. */
export class BlobContainmentError extends Schema.TaggedErrorClass<BlobContainmentError>()(
  "BlobContainmentError",
  {
    operation: Schema.String,
    message: Schema.String
  }
) {}

/** The platform object-store operation failed. */
export class BlobStoreIoError extends Schema.TaggedErrorClass<BlobStoreIoError>()("BlobStoreIoError", {
  operation: Schema.String,
  message: Schema.String
}) {}

/** Redacts platform details before they cross the object-store boundary. */
export const blobStoreIoError = (operation: string, _cause: unknown): BlobStoreIoError =>
  new BlobStoreIoError({ operation, message: "platform storage operation failed" })

/** Typed failures exposed by the blob-store boundary. */
export type BlobStoreError =
  | BlobContainmentError
  | BlobIntegrityError
  | BlobNotFoundError
  | BlobStoreInputError
  | BlobStoreIoError
  | BlobTooLargeError
  | BlobUnexpectedEofError

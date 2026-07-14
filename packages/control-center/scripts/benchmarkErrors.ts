import * as Schema from "effect/Schema"

/** A benchmark input, correctness, or bounded-work invariant failed independently of machine speed. */
export class BenchmarkInvariantError extends Schema.TaggedErrorClass<BenchmarkInvariantError>()(
  "BenchmarkInvariantError",
  { reason: Schema.String }
) {}

/** A durable benchmark report could not be collected, encoded, written, read, or decoded. */
export class BenchmarkReportError extends Schema.TaggedErrorClass<BenchmarkReportError>()("BenchmarkReportError", {
  reason: Schema.String
}) {}

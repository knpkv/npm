/** Bound one complete Connect read, including response decoding, without extending it on a poll. */
import { Duration, Schema } from "effect"

export const connectReadDeadline = Duration.seconds(10)

export class ConnectTimeoutError extends Schema.TaggedError<ConnectTimeoutError>()("ConnectTimeoutError", {}) {}

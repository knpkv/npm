/**
 * The status for a request the monitor server could not finish: a publish that stalls past the
 * deadline is a timeout (408); any other failure reading or decoding it is the publisher's request
 * (400). Internal to the server, outside every published entry point.
 */
export const failureStatus = (error: { readonly _tag: string }): 400 | 408 => error._tag === "TimeoutError" ? 408 : 400

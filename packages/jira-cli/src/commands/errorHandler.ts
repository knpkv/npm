/**
 * Error handler for CLI commands.
 *
 * @module
 */
import * as Cause from "effect/Cause"

/**
 * Handle errors from CLI execution.
 *
 * @param cause - The cause of the error
 *
 * @category Error Handling
 */
export const handleError = <E>(cause: Cause.Cause<E>): void => {
  for (const error of Cause.failures(cause)) {
    if (error && typeof error === "object") {
      const err = error as Record<string, unknown>
      if ("message" in err) {
        process.stderr.write(`${err["message"]}\n`)
      }
      // Show cause details for API errors
      if ("cause" in err && err["cause"]) {
        const causeObj = err["cause"]
        if (typeof causeObj === "object" && causeObj !== null) {
          const causeRecord = causeObj as Record<string, unknown>
          // Handle HttpClientError with response body
          if ("error" in causeRecord) {
            process.stderr.write(`  ${JSON.stringify(causeRecord["error"])}\n`)
          } else if ("message" in causeRecord) {
            process.stderr.write(`  ${causeRecord["message"]}\n`)
          }
        } else {
          process.stderr.write(`  ${String(causeObj)}\n`)
        }
      }
    } else {
      process.stderr.write(`${String(error)}\n`)
    }
  }

  for (const defect of Cause.defects(cause)) {
    if (defect instanceof Error) {
      process.stderr.write(`Error: ${defect.message}\n`)
    }
  }
}

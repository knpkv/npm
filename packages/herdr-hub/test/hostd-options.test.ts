/**
 * The options an embedding of hostd passes. The Node path is required at this boundary: the entry owns
 * `process.execPath`, and an embedding that left it out ran no installed apps, saying so only in each app's log.
 */
import { expectTypeOf, it } from "vitest"
import type { HostdProgramOptions, makeHostdProgram } from "../src/hostd.js"

it("requires the Node path installed apps run on", () => {
  expectTypeOf<HostdProgramOptions["node"]>().toEqualTypeOf<string>()
  // No default options: a call without them doesn't typecheck.
  expectTypeOf<Parameters<typeof makeHostdProgram>>().toEqualTypeOf<[options: HostdProgramOptions]>()
})

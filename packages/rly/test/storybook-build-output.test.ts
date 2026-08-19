import { describe, expect, it } from "vitest"
import { assertWarningFreeStorybookOutput } from "../scripts/storybook-build-output.js"

describe("Storybook build output", () => {
  it("rejects ANSI-decorated Rolldown plugin timing warnings", () => {
    expect(() =>
      assertWarningFreeStorybookOutput(
        "\u001B[33m[PLUGIN_TIMINGS]\u001B[0m plugin vite:react took 80% of the build time"
      )
    ).toThrow(/\[PLUGIN_TIMINGS\]/u)
  })

  it("rejects plain and ANSI-decorated Node DEP0205 warnings", () => {
    expect(() => assertWarningFreeStorybookOutput("[DEP0205] DeprecationWarning: Buffer() is deprecated"))
      .toThrow(/\[DEP0205\]/u)
    expect(() => assertWarningFreeStorybookOutput("\u001B[33m[DEP0205]\u001B[0m DeprecationWarning"))
      .toThrow(/\[DEP0205\]/u)
  })

  it("accepts ordinary Storybook progress and asset-size output", () => {
    expect(() => assertWarningFreeStorybookOutput("Storybook build completed successfully\niframe.js 1,147.60 kB")).not
      .toThrow()
  })
})

import { describe, expect, it } from "vitest"

import {
  PluginConfigurationFailure,
  pluginFailureClass,
  pluginFailureSafeMessage
} from "../../src/server/plugins/failures.js"

describe("plugin failure class", () => {
  // A missing resource is fixed by editing the connection; calling it unknown made the UI say "sync again".
  it("classifies a configuration failure as configuration and names a missing repository", () => {
    const missing = new PluginConfigurationFailure({ diagnosticCode: "codecommit-provider-object-not-found" })
    expect(pluginFailureClass(missing)).toBe("configuration")
    expect(pluginFailureSafeMessage(missing)).toBe(
      "The repository wasn’t found in this account and region. Check the repository name or region, then edit the connection."
    )
    expect(pluginFailureSafeMessage(new PluginConfigurationFailure({ diagnosticCode: "clockify-user-ids-invalid" })))
      .toBe(
        "This connection’s settings don’t match the provider. Check them, then edit the connection."
      )
  })
})

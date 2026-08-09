import { describe, expect, it } from "vitest"
import { assumeConsoleArgs } from "../src/tui/browser-command.js"

describe("Granted browser command", () => {
  it("uses the long console-destination alias without colliding with duration", () => {
    expect(assumeConsoleArgs("https://console.aws.amazon.com/codecommit/pr/44", "dev-admin")).toEqual([
      "--cd",
      "https://console.aws.amazon.com/codecommit/pr/44",
      "dev-admin"
    ])
  })
})

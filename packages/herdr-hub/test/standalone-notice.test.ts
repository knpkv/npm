import { describe, expect, it } from "@effect/vitest"
import { standaloneNotice } from "../src/internal/standalone-notice.js"

describe("standalone notice", () => {
  // The one stderr line a standalone start prints. The npx smoke job matches its URL part.
  it("names the config path it looked for and the URL it serves", () => {
    expect(standaloneNotice("/home/owner/.config/fleet/config.json", "http://127.0.0.1:4778")).toBe(
      "hostd: no fleet config at /home/owner/.config/fleet/config.json; running standalone on http://127.0.0.1:4778/ (set FLEET_CONFIG_PATH to use one)"
    )
  })
})

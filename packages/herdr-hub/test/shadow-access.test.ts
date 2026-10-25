import { describe, expect, it } from "@effect/vitest"
import type { Principal } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { shadowFinding } from "../src/internal/shadow-access.js"

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const config = {
  allowedUsers: ["owner@example.test"],
  approvalNodes: ["node-phone"],
  machines: [{ host, nodeId: "node-hub" }]
}
const fleetHost: Principal = { _tag: "Host", nodeId: "node-hub" }
const laptop: Principal = { _tag: "Person", login: "owner@example.test", nodeId: "node-laptop", presence: "none" }
const finding = (principal: Principal | null, method: string, pathname: string, status = 200) =>
  shadowFinding(config, { listener: "serve", method, pathname, status, principal })

describe("shadow access", () => {
  // Today's handler served it, identity would refuse it: that is what the flip changes, so it is logged.
  it("reports a request today's checks served and identity would refuse, keyed by principal and family", () => {
    expect(finding(fleetHost, "POST", "/v1/push/subscriptions")).toEqual({
      key: "refused serve Host push.write",
      fields: { listener: "serve", principal: "Host", family: "push.write", requirement: "push" }
    })
    expect(finding(laptop, "POST", "/v1/jobs/job-1/approve")?.key).toBe("refused serve Person jobs.decide")
  })

  // Nothing to report when both agree, when today's checks already refused, or for public files.
  it("reports nothing when identity agrees, today already refused, or the route is public", () => {
    expect(finding(laptop, "POST", "/v1/push/subscriptions")).toBeNull()
    expect(finding(fleetHost, "POST", "/v1/push/subscriptions", 403)).toBeNull()
    expect(finding({ _tag: "Anonymous" }, "GET", "/assets/index.css")).toBeNull()
    expect(finding(null, "POST", "/v1/push/subscriptions")).toBeNull()
  })

  // A route no family names is reported once per method and leading path, whoever called and however it
  // answered, so identifiers in the path don't make a new line each time.
  it("reports a route no family names by its method and leading path", () => {
    expect(finding(laptop, "GET", "/v1/something-new/item-1", 404)).toEqual({
      key: "undeclared serve GET /v1/something-new",
      fields: { listener: "serve", method: "GET", path: "/v1/something-new" }
    })
  })
})

import * as Schema from "effect/Schema"

import { type Failure, type Identity, Manifest, type Snapshot, type Waiver } from "../src/schema.js"

export const identity: Identity = { screen: "toy", state: "passing", viewport: 390, theme: "light" }
export const state = {
  screen: "toy",
  state: "passing",
  route: "/screen.html",
  viewports: [390],
  themes: ["light"],
  status: "implemented",
  source: "html",
  ref: "screens/screen.html",
  regions: ["content"]
} satisfies Manifest["states"][number]
export const manifestInput = {
  version: 1,
  product: "toy",
  fixture: "fixture.json",
  live: { package: "@knpkv/design-conformance", adapter: "packages/design-conformance/scripts/fixture.ts" },
  files: { "fixture.json": "a".repeat(64), "screens/screen.html": "b".repeat(64) },
  states: [state],
  enforcement: { touched: "required", legacy: { mode: "report-only", until: "2026-10-18T00:00:00.000Z" } }
} satisfies Schema.Codec.Encoded<typeof Manifest>
export const manifest: Manifest = Schema.decodeUnknownSync(Manifest)(manifestInput)
export const failure: Failure = { ...identity, region: "content", rule: "copy", detail: "Copy differs" }
export const waiver: Waiver = {
  screen: "toy",
  state: "passing",
  region: "content",
  rule: "copy",
  reason: "design-impossible",
  detail: "Intentional fixture failure",
  decisionLink: "https://example.test/decisions/fixture"
}
export const snapshot: Snapshot = {
  overflow: false,
  regions: [{
    name: "content",
    copy: "Reviewer workspace",
    parent: null,
    box: { x: 16, y: 16, width: 358, height: 100 },
    overflow: false,
    styles: { color: "rgb(0, 0, 0)" }
  }]
}

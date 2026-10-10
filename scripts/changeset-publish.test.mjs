import assert from "node:assert/strict"
import test from "node:test"

import { publishEnv, readPublishOutput } from "./changeset-publish.mjs"

const staged = (name, version) =>
  `└ E409: 409 Conflict - PUT https://registry.npmjs.org/${name.replace("/", "%2f")} - ` +
  `Cannot publish over previously staged version "${version}".`

// The Release run on 2026-10-09 that failed on @knpkv/rly 0.18.0, ANSI codes included.
const rlyStaged = [
  "🦋 changeset v3.0.3",
  "",
  "These packages will be published as they were not found in the registry:",
  "@knpkv/rly@0.18.0",
  "31 packages are already published.",
  "\u001b[?25l◒  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Publishing packages...",
  "\u001b[1G\u001b[J\u001b[?25h",
  "Some packages failed to publish:",
  "@knpkv/rly@0.18.0",
  staged("@knpkv/rly", "0.18.0"),
  "🦋 Exited with code 1"
].join("\n")

test("a version npm already holds in staging counts as published", () => {
  assert.deepEqual(readPublishOutput(rlyStaged), { staged: [{ name: "@knpkv/rly", version: "0.18.0" }] })
})

test("staged and newly published releases together complete the release", () => {
  const output = [
    "These packages will be published as they were not found in the registry:",
    "@knpkv/agent-usage@0.7.0",
    "@knpkv/rly@0.18.0",
    "\u001b[1G\u001b[J◇  Successfully published:",
    "@knpkv/agent-usage@0.7.0",
    "Some packages failed to publish:",
    "@knpkv/rly@0.18.0",
    staged("@knpkv/rly", "0.18.0"),
    "◒  Creating git tags...",
    "◇  Created git tags:",
    "- @knpkv/agent-usage@0.7.0",
    "🦋 Exited with code 1"
  ].join("\n")
  assert.deepEqual(readPublishOutput(output), { staged: [{ name: "@knpkv/rly", version: "0.18.0" }] })
})

test("a staged conflict for another version or package is a failure", () => {
  assert.deepEqual(readPublishOutput(rlyStaged.replace(`version "0.18.0"`, `version "0.17.9"`)), { staged: null })
  assert.deepEqual(readPublishOutput(rlyStaged.replace("%2frly - ", "%2frly-cli - ")), { staged: null })
})

test("any other publish error fails, even beside a staged conflict", () => {
  const output = [
    "These packages will be published as they were not found in the registry:",
    "@knpkv/agent-usage@0.7.0",
    "@knpkv/rly@0.18.0",
    "Some packages failed to publish:",
    "@knpkv/agent-usage@0.7.0",
    "└ E403: 403 Forbidden - PUT https://registry.npmjs.org/@knpkv%2fagent-usage - You do not have permission.",
    "@knpkv/rly@0.18.0",
    staged("@knpkv/rly", "0.18.0"),
    "🦋 Exited with code 1"
  ].join("\n")
  assert.deepEqual(readPublishOutput(output), { staged: null })
})

test("a planned release that was never attempted fails the run", () => {
  // changesets stops after a batch with a failure, so later batches publish nothing.
  const output = rlyStaged.replace("@knpkv/rly@0.18.0\n31", "@knpkv/rly@0.18.0\n@knpkv/rly-cli@0.4.0\n31")
  assert.deepEqual(readPublishOutput(output), { staged: null })
})

test("a failure without npm's reason, or no failure block at all, fails", () => {
  assert.deepEqual(readPublishOutput(rlyStaged.replace(`${staged("@knpkv/rly", "0.18.0")}\n`, "")), { staged: null })
  assert.deepEqual(readPublishOutput("🦋 error Something else went wrong"), { staged: null })
})

test("without changesets' plan, or with a failure it did not plan, nothing counts as published", () => {
  assert.deepEqual(readPublishOutput(rlyStaged.replace("These packages will be published", "Publishing")), {
    staged: null
  })
  const unplanned = rlyStaged.replace("@knpkv/rly@0.18.0\n31", "@knpkv/rly-cli@0.4.0\n31")
  assert.deepEqual(readPublishOutput(unplanned), { staged: null })
})

test("a tag step that fails after the failure block fails the run", () => {
  const tagFailure = rlyStaged.replace(
    "🦋 Exited with code 1",
    "■  Error: Command failed: git tag @knpkv/agent-usage@0.7.0\n    at tag (git.mjs:12:5)\n🦋 Exited with code 1"
  )
  assert.deepEqual(readPublishOutput(tagFailure), { staged: null })
  assert.deepEqual(readPublishOutput(rlyStaged.replace("\n🦋 Exited with code 1", "")), { staged: null })
})

test("publishing runs no package's lifecycle scripts, for pnpm 11 and earlier", () => {
  // The workspace is built before publishing; a concurrent prepack rebuild deleted a dist another package read.
  assert.deepEqual(publishEnv, { npm_config_ignore_scripts: "true", pnpm_config_ignore_scripts: "true" })
})

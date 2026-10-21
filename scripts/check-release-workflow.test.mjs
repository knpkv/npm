import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { parseDocument } from "yaml"

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())
const workflowText = await runtime.runPromise(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.readFileString(fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)))
  })
)
const steps = parseDocument(workflowText).toJS().jobs.release.steps
const stepIndex = (name) => steps.findIndex((step) => step.name === name)
const changesetsAction = (step) => String(step.uses).startsWith("changesets/action@")

const released = "steps.released.outputs.outstanding == 'true'"

test("ready versions publish before pending changesets are versioned", () => {
  const prepare = stepIndex("Prepare versions ready to publish")
  const publish = stepIndex("Publish the released versions")
  const restore = stepIndex("Restore pending changesets")
  const usual = stepIndex("Create Release Pull Request or Publish")
  assert.ok(prepare >= 0 && prepare < publish && publish < restore && restore < usual)
  assert.deepEqual(
    steps.filter(changesetsAction).map((step) => step.name),
    [steps[publish].name, steps[usual].name]
  )
  assert.equal(steps[prepare].if, undefined)
  assert.equal(steps[prepare].id, "released")
  assert.equal(steps[prepare].run, "node scripts/check-version-bumps.mjs --prepare-release")

  // Only ready versions take the publish-first path. With no changeset in view the action can only publish,
  // and it fails the step when publishing fails. Restore brings back the changesets.
  assert.equal(steps[publish].if, released)
  assert.equal(steps[publish].with["version-script"], undefined)
  assert.equal(steps[publish].with["publish-script"], "pnpm changeset:publish")
  assert.equal(steps[publish]["continue-on-error"], undefined)
  assert.equal(steps[restore].if, released)
  assert.equal(steps[restore].run, "git checkout HEAD -- .changeset")

  // Otherwise the action makes its usual choice; after a release it runs only to version what is pending.
  assert.equal(
    steps[usual].if,
    "steps.released.outputs.pending == 'true' || (steps.released.outputs.outstanding != 'true' && steps.released.outputs.propagating != 'true')"
  )
  assert.equal(steps[usual].with["version-script"], "pnpm changeset:version")
  assert.equal(steps[usual].with["publish-script"], "pnpm changeset:publish")
})

// TOKEN_GITHUB is a personal token; when it expired every release failed with changelog-github's
// "Fetched data from GitHub has missing data" (2026-10-17 on). The check names the cause first.
test("the release token is checked before any step that needs it", () => {
  const check = stepIndex("Check the release token")
  assert.ok(check >= 0)
  assert.equal(steps[check].env.GH_TOKEN, "${{ secrets.TOKEN_GITHUB }}")
  // Every other step that holds the token comes after the check, including any added later.
  steps.forEach((step, index) => {
    if (index !== check && JSON.stringify(step).includes("secrets.TOKEN_GITHUB")) assert.ok(check < index, step.name)
  })
  // The same kind of call changelog-github makes, so a token it would reject fails here. Only a
  // 401 is blamed on the token; anything else (5xx, network) is reported as such, with gh's output.
  assert.match(steps[check].run, /gh api graphql/u)
  assert.match(steps[check].run, /Bad credentials/u)
  assert.match(steps[check].run, /::error title=TOKEN_GITHUB rejected::/u)
  assert.match(steps[check].run, /::error title=Could not reach GitHub::/u)
  for (const step of steps.filter(changesetsAction)) {
    assert.equal(step.with["github-token"], "${{ secrets.TOKEN_GITHUB }}", step.name)
  }
})

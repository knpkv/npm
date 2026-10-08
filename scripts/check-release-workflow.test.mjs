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
  const restore = stepIndex("Restore pending changesets and held packages")
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
  // and it fails the step when publishing fails. Restore brings back the changesets and held manifests.
  assert.equal(steps[publish].if, released)
  assert.equal(steps[publish].with["version-script"], undefined)
  assert.equal(steps[publish].with["publish-script"], "pnpm changeset:publish")
  assert.equal(steps[publish]["continue-on-error"], undefined)
  assert.equal(steps[restore].if, released)
  assert.equal(steps[restore].run, "git checkout HEAD -- .changeset packages")

  // Otherwise the action makes its usual choice; after a release it runs only to version what is pending.
  assert.equal(
    steps[usual].if,
    "steps.released.outputs.outstanding != 'true' || steps.released.outputs.pending == 'true'"
  )
  assert.equal(steps[usual].with["version-script"], "pnpm changeset:version")
  assert.equal(steps[usual].with["publish-script"], "pnpm changeset:publish")
})

import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { parseDocument } from "yaml"

import {
  classifyNpmView,
  installCommand,
  npxSmokeCases,
  packIdentity,
  parseEnvFile,
  parseSmokeArguments,
  smokeManifest
} from "./test-npx-smoke.mjs"

const packs = [
  { name: "@knpkv/herdr-hub", version: "0.46.0", file: "/packs/knpkv-herdr-hub-0.46.0.tgz" },
  { name: "@knpkv/alchemy-console", version: "0.6.0", file: "/packs/knpkv-alchemy-console-0.6.0.tgz" },
  { name: "@knpkv/rly", version: "0.24.0", file: "/packs/knpkv-rly-0.24.0.tgz" }
]

test("every @knpkv package comes from its tarball by default, transitive ones through overrides", () => {
  const manifest = smokeManifest({ packs, owners: ["@knpkv/herdr-hub"], published: new Set() })
  assert.deepEqual(manifest.dependencies, { "@knpkv/herdr-hub": "file:/packs/knpkv-herdr-hub-0.46.0.tgz" })
  assert.deepEqual(manifest.overrides, {
    "@knpkv/herdr-hub": "file:/packs/knpkv-herdr-hub-0.46.0.tgz",
    "@knpkv/alchemy-console": "file:/packs/knpkv-alchemy-console-0.6.0.tgz",
    "@knpkv/rly": "file:/packs/knpkv-rly-0.24.0.tgz"
  })
})

// After a release, users get the new hub with whatever npm already has for its dependencies. That is how
// hostd 0.45.0 shipped against an alchemy-console that lacked `./host`: only the hub was new.
test("with the registry for published versions, only what npm lacks comes from a tarball", () => {
  const manifest = smokeManifest({
    packs,
    owners: ["@knpkv/herdr-hub", "@knpkv/alchemy-console"],
    published: new Set(["@knpkv/alchemy-console@0.6.0", "@knpkv/rly@0.24.0"])
  })
  assert.deepEqual(manifest.dependencies, {
    "@knpkv/herdr-hub": "file:/packs/knpkv-herdr-hub-0.46.0.tgz",
    "@knpkv/alchemy-console": "0.6.0"
  })
  assert.deepEqual(manifest.overrides, { "@knpkv/herdr-hub": "file:/packs/knpkv-herdr-hub-0.46.0.tgz" })
})

test("an app with no packed tarball fails by name rather than installing something else", () => {
  assert.throws(
    () => smokeManifest({ packs, owners: ["@knpkv/jcf-web"], published: new Set() }),
    (error) => error._tag === "SmokeFailed" && error.reason === "no packed tarball for @knpkv/jcf-web"
  )
})

test("pnpm pack names map back to package and version; other files are skipped", () => {
  assert.deepEqual(packIdentity("knpkv-herdr-hub-0.46.0.tgz"), { name: "@knpkv/herdr-hub", version: "0.46.0" })
  assert.deepEqual(packIdentity("knpkv-codecommit-web-0.39.0.tgz"), {
    name: "@knpkv/codecommit-web",
    version: "0.39.0"
  })
  assert.deepEqual(packIdentity("knpkv-rly-1.0.0-next.2.tgz"), { name: "@knpkv/rly", version: "1.0.0-next.2" })
  assert.equal(packIdentity("README.md"), undefined)
  assert.equal(packIdentity("other-0.1.0.tgz"), undefined)
})

test("arguments need exactly one tarball directory; unknown flags are rejected", () => {
  assert.deepEqual(parseSmokeArguments(["--tarballs", "/packs"]), {
    tarballs: "/packs",
    registryForPublished: false,
    installThrough: undefined,
    cases: []
  })
  assert.deepEqual(
    parseSmokeArguments([
      "--tarballs",
      "/packs",
      "--registry-for-published",
      "--install-through",
      "sfw",
      "--case",
      "hostd",
      "--case",
      "jcf-web"
    ]),
    { tarballs: "/packs", registryForPublished: true, installThrough: "sfw", cases: ["hostd", "jcf-web"] }
  )
  for (const invalid of [[], ["--case", "hostd"], ["--tarballs"], ["--tarballs", "/a", "--tarballs", "/b"], ["--x"]]) {
    assert.equal(parseSmokeArguments(invalid), null, invalid.join(" "))
  }
})

test("env files load KEY=value lines, keeping '=' inside values", () => {
  assert.deepEqual(parseEnvFile("# keys\nMONITOR_PUBLISH_TOKEN=publish_a=b\n\nMONITOR_VIEW_TOKEN=view_c\n"), {
    MONITOR_PUBLISH_TOKEN: "publish_a=b",
    MONITOR_VIEW_TOKEN: "view_c"
  })
})

// The apps a user runs with npx, hostd included: a case missing here is a regression nobody sees until npm.
test("the case list covers every standalone app and hostd", () => {
  assert.deepEqual(npxSmokeCases.map((smokeCase) => smokeCase.bin).sort(), [
    "agent-usage",
    "alchemy-console",
    "codecommit",
    "control-center",
    "herdr-monitor",
    "hostd",
    "jcf-web"
  ])
})

// The repository routes every dependency install through Socket Firewall; the smoke project's install of the
// apps' third-party dependencies is one too, so CI names the wrapper and the command starts with it.
test("the project install runs through the named wrapper, and plainly only when none is named", () => {
  assert.deepEqual(installCommand("sfw"), ["sfw", ["npm", "install", "--no-audit", "--no-fund", "--loglevel=error"]])
  assert.deepEqual(installCommand(undefined), ["npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]])
})

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())

test("the CI job installs through Socket Firewall", async () => {
  const text = await runtime.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      return yield* fileSystem.readFileString(fileURLToPath(new URL("../.github/workflows/check.yml", import.meta.url)))
    })
  )
  const workflow = parseDocument(text).toJS()
  const run = workflow.jobs["npx-smoke"].steps.find((step) => step.name === "Run each app from its tarball").run
  assert.match(run, /node scripts\/test-npx-smoke\.mjs --tarballs "\$RUNNER_TEMP\/packs" --install-through sfw/u)
})

// Release mode exists to test what npm serves. A registry hiccup read as "not published" would quietly test
// the tarball instead, the very gap that let hostd 0.45.0 ship, so only npm's own "no such version" counts.
test("npm view: a served version is published, a missing one is not, anything else fails the run", () => {
  const ask = { name: "@knpkv/herdr-hub", version: "0.47.0" }
  assert.deepEqual(classifyNpmView({ ...ask, exitCode: 0, stdout: "0.47.0\n", stderr: "" }), { _tag: "Published" })
  // Older npm prints nothing and exits 0 for a version the package does not have.
  assert.deepEqual(classifyNpmView({ ...ask, exitCode: 0, stdout: "", stderr: "" }), { _tag: "Unpublished" })
  // npm 11 answers E404, for a missing version and for a package it has never seen.
  assert.deepEqual(
    classifyNpmView({ ...ask, exitCode: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" }),
    { _tag: "Unpublished" }
  )
  for (const stderr of ["npm error code ETIMEDOUT", "npm error code E503", "npm error code E429"]) {
    const result = classifyNpmView({ ...ask, exitCode: 1, stdout: "", stderr })
    assert.equal(result._tag, "Unknown", stderr)
    assert.match(result.reason, /@knpkv\/herdr-hub@0\.47\.0/u)
  }
  assert.equal(classifyNpmView({ ...ask, exitCode: 0, stdout: "0.46.0\n", stderr: "" })._tag, "Unknown")
})

import assert from "node:assert/strict"
import test from "node:test"

import { npxSmokeCases, packIdentity, parseEnvFile, parseSmokeArguments, smokeManifest } from "./test-npx-smoke.mjs"

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
    cases: []
  })
  assert.deepEqual(
    parseSmokeArguments(["--tarballs", "/packs", "--registry-for-published", "--case", "hostd", "--case", "jcf-web"]),
    { tarballs: "/packs", registryForPublished: true, cases: ["hostd", "jcf-web"] }
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

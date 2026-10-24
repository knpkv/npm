/** The `hubApp` field the installer reads before install: it must match the app the package actually runs. */
import { describe, expect, it } from "@effect/vitest"
import { HubAppPackageField } from "@knpkv/hub-app"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { usageManifest } from "../src/app.js"

const PackageJson = Schema.Struct({
  bin: Schema.Record(Schema.String, Schema.String),
  files: Schema.Array(Schema.String),
  hubApp: HubAppPackageField
})
const packageJson = Schema.decodeUnknownSync(Schema.fromJsonString(PackageJson))(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
)

describe("hubApp", () => {
  it("runs the package's own executable script, which the published files include", () => {
    expect(packageJson.hubApp.bin).toBe("dist/bin.js")
    expect(`./${packageJson.hubApp.bin}`).toBe(packageJson.bin["herdr-usage"])
    expect(packageJson.files).toContain("dist")
  })

  // The installer shows these before install and checks them against the manifest after.
  it("declares the contract and services the manifest declares", () => {
    const manifest = usageManifest("0.0.0-test")
    expect([packageJson.hubApp.contract, packageJson.hubApp.services]).toEqual([manifest.contract, manifest.services])
  })
})

/** Synthetic CI metadata; artifact locators and receipt hashes stay in server-side test inputs. */
import { Crypto, DateTime, Effect, Schema } from "effect"
import { crc32, deflateRawSync } from "node:zlib"
import type { Artifact, Run } from "../src/server/plan/github.js"
import { Receipt } from "../src/server/plan/receipt.js"

export const head = "3f9c2e1" + "a".repeat(33)
export const base = "8a41d07" + "b".repeat(33)
export const now = 1_792_073_100_000
const hash = (bytes: Uint8Array) =>
  Effect.gen(function*() {
    const cryptoService = yield* Crypto.Crypto
    const digest = yield* cryptoService.digest("SHA-256", bytes)
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }).pipe(Effect.orDie)
const hex = "a".repeat(64)
export const receipt = (hasChanges = true): Receipt => {
  const semantic = {
    schema: "alchemy-beta77/ci-native-v1",
    stack: "site",
    stage: "prod",
    contentDigest: hex,
    impact: ["site"],
    artifacts: { "Site/build": hex },
    assetHashes: { Site: hex },
    output: hex,
    rows: [{
      fqn: "Site",
      type: "Cloudflare.Worker",
      action: hasChanges ? "update" : "noop",
      changedKeys: hasChanges ? ["compatibilityDate", "routes"] : [],
      props: hex,
      attr: hex,
      bindings: hex,
      mode: "live"
    }]
  }
  return Schema.decodeUnknownSync(Receipt)({
    schema: 1,
    stack: "site",
    pr: 42,
    head,
    base,
    toolsSha: base,
    toolsDigest: hex,
    runId: 101,
    producerRunId: 100,
    publisherJobId: 201,
    rawArtifactId: 300,
    rawArtifactDigest: `sha256:${hex}`,
    assurance: "untrusted-native-data/trusted-publication",
    native: {
      schema: 1,
      stack: "site",
      stage: "prod",
      statePuts: 0,
      hasChanges,
      digest: hasChanges
        ? "6ed98868f5696082aa4fb197ac07c022f9a90fd93e80ce5adb82c0ed3531ad2e"
        : "c0fc57ca7604e3e8b803681995f487c949cee7870d418547b7699e948d7d8a2e",
      semantic
    }
  })
}

/** A real single-member ZIP with independent local/central metadata and CRC, optionally deflated. */
export const zip = (text: string, name = "plan.json", deflated = false): Uint8Array => {
  const filename = new TextEncoder().encode(name)
  const raw = new TextEncoder().encode(text)
  const data = deflated ? deflateRawSync(raw) : raw
  const localSize = 30 + filename.length + data.length
  const centralSize = 46 + filename.length
  const bytes = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(bytes.buffer)
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true)
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true)
  u32(0, 0x04034b50)
  u16(4, 20)
  u16(8, deflated ? 8 : 0)
  u32(14, crc32(raw))
  u32(18, data.length)
  u32(22, raw.length)
  u16(26, filename.length)
  bytes.set(filename, 30)
  bytes.set(data, 30 + filename.length)
  u32(localSize, 0x02014b50)
  u16(localSize + 4, 20)
  u16(localSize + 6, 20)
  u16(localSize + 10, deflated ? 8 : 0)
  u32(localSize + 16, crc32(raw))
  u32(localSize + 20, data.length)
  u32(localSize + 24, raw.length)
  u16(localSize + 28, filename.length)
  bytes.set(filename, localSize + 46)
  const end = localSize + centralSize
  u32(end, 0x06054b50)
  u16(end + 8, 1)
  u16(end + 10, 1)
  u32(end + 12, centralSize)
  u32(end + 16, localSize)
  return bytes
}
const instant = (millis: number) => DateTime.makeUnsafe(millis)
export const producer: Run = {
  id: 100,
  workflow_id: 10,
  path: ".github/workflows/infra.yml",
  event: "pull_request",
  head_sha: head,
  head_branch: "feature",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  run_started_at: instant(now - 200_000),
  created_at: instant(now - 200_000),
  updated_at: instant(now - 150_000),
  actor: { id: 833092 },
  triggering_actor: { id: 833092 },
  referenced_workflows: [{
    path: "knpkv/infra/.github/workflows/_infra-plan.yml@refs/heads/main",
    ref: "refs/heads/main",
    sha: base
  }],
  repository: { id: 1288997422 },
  head_repository: { id: 1288997422 },
  pull_requests: [{ number: 42, head: { sha: head }, base: { sha: base } }]
}
export const publisher: Run = {
  ...producer,
  id: 101,
  workflow_id: 11,
  path: ".github/workflows/infra-publish.yml",
  event: "workflow_run",
  head_branch: "main",
  head_sha: base,
  pull_requests: []
}
export const artifact = (bytes: Uint8Array) =>
  hash(bytes).pipe(Effect.map((digest): Artifact => ({
    id: 301,
    name: `infra-plan-site-${head}`,
    size_in_bytes: bytes.length,
    digest: `sha256:${digest}`,
    expired: false,
    created_at: instant(now - 60_000),
    expires_at: instant(now + 14 * 86_400_000),
    workflow_run: {
      id: 101,
      repository_id: 1288997422,
      head_repository_id: 1288997422,
      head_branch: "main",
      head_sha: base
    }
  })))

/** Independently pinned semantic hash for the six-resource org fixture. */
export const orgReceipt = (): Receipt => {
  const site = receipt(false)
  return Schema.decodeUnknownSync(Receipt)({
    ...site,
    stack: "aws-org",
    native: {
      ...site.native,
      stack: "aws-org",
      stage: "org",
      digest: "9b5d925628fbf9e29d61d386b88045fb3072667acbd269d652e8aa69c05d54b6",
      semantic: {
        schema: "alchemy-beta81/ci-native-v1",
        stack: "aws-org",
        stage: "org",
        contentDigest: hex,
        impact: ["aws-org"],
        artifacts: {},
        output: hex,
        rows: ["Platform", "Sandbox", "Dev1Placement", "DevPlacement", "Dev2Placement", "InfraPlacement"].map((
          fqn
        ) => ({
          fqn,
          type: fqn === "Platform" || fqn === "Sandbox"
            ? "AWS.Organizations.OrganizationalUnit"
            : "Org.AccountPlacement",
          action: "noop",
          changedKeys: [],
          props: hex,
          attr: hex,
          bindings: hex,
          mode: "live"
        }))
      }
    }
  })
}

/** Streaming ZIP writers place sizes/CRC after the member rather than in its local header. */
export const descriptorZip = (text: string): Uint8Array => {
  const original = zip(text, "plan.json", true)
  const oldView = new DataView(original.buffer)
  const directory = oldView.getUint32(original.length - 6, true)
  const bytes = new Uint8Array(original.length + 16)
  bytes.set(original.subarray(0, directory))
  bytes.set(original.subarray(directory), directory + 16)
  const view = new DataView(bytes.buffer)
  view.setUint16(6, 8, true)
  for (const offset of [14, 18, 22]) view.setUint32(offset, 0, true)
  view.setUint32(directory, 0x08074b50, true)
  view.setUint32(directory + 4, oldView.getUint32(14, true), true)
  view.setUint32(directory + 8, oldView.getUint32(18, true), true)
  view.setUint32(directory + 12, oldView.getUint32(22, true), true)
  view.setUint16(directory + 24, 8, true)
  view.setUint32(bytes.length - 6, directory + 16, true)
  return bytes
}

import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authorizeWhois, discoverFleetPeers, make, Tailscale, type TailscaleClient } from "../src/index.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const node = (
  host: string,
  id: string,
  online: boolean,
  addresses: ReadonlyArray<string>
) => ({
  HostName: host,
  ID: id,
  Online: online,
  TailscaleIPs: addresses
})

describe("Tailscale fleet boundary", () => {
  it.effect("normalizes a valid null peer map to an empty fleet", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-tailscale-no-peers-test-"))
    const command = join(root, "tailscale-test")
    const writeStatus = (peer: "null" | "{}") =>
      writeFileSync(
        command,
        `#!/bin/sh\nprintf '%s\\n' '{"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["100.64.0.1"]},"Peer":${peer}}'\n`,
        { mode: 0o700 }
      )
    const peerValues: ReadonlyArray<"null" | "{}"> = ["null", "{}"]
    return Effect.gen(function*() {
      for (const peer of peerValues) {
        writeStatus(peer)
        const client = yield* make(command)
        expect((yield* client.status).Peer).toEqual({})
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("accepts only specified IPv4 output", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-tailscale-ipv4-test-"))
    const command = join(root, "tailscale-test")
    const writeOutput = (output: string): void =>
      writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, {
        mode: 0o700
      })
    return Effect.gen(function*() {
      for (const invalid of ["0.0.0.0", "not-an-ip"]) {
        writeOutput(invalid)
        const client = yield* make(command)
        const result = yield* Effect.result(client.ipv4)
        expect(result).toMatchObject({
          failure: { _tag: "HerdrTailscale.DecodeError" }
        })
      }
      writeOutput("100.64.0.1")
      const client = yield* make(command)
      expect(yield* client.ipv4).toBe("100.64.0.1")
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => rmSync(root, { force: true, recursive: true }))
      ),
      provideNodeServices
    )
  })

  it.effect("rejects schema-valid output from a failed command", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-tailscale-exit-test-"))
    const command = join(root, "tailscale-test")
    const script = (exitCode: number) =>
      `#!/bin/sh
printf '%s\n' '{"Node":{"StableID":"node-a"},"UserProfile":{"LoginName":"andrey@example.com"}}'
exit ${exitCode}
`
    writeFileSync(command, script(7), { mode: 0o700 })
    return Effect.gen(function*() {
      const failedClient = yield* make(command)
      const failed = yield* Effect.result(failedClient.whois("100.64.0.1"))
      expect(Result.isFailure(failed)).toBe(true)
      if (Result.isFailure(failed)) {
        expect(failed.failure._tag).toBe("HerdrTailscale.CommandError")
      }

      writeFileSync(command, script(0), { mode: 0o700 })
      const validClient = yield* make(command)
      expect(yield* validClient.whois("100.64.0.1")).toMatchObject({
        Node: { StableID: "node-a" }
      })
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("discovers configured peers without changing Tailscale state", () => {
    const client: TailscaleClient = {
      ipv4: Effect.succeed("100.64.0.1"),
      status: Effect.succeed({
        Self: node("SER8", "node-ser8", true, ["100.64.0.1"]),
        Peer: {
          pi: node("PI", "node-pi", false, [
            "fd7a:115c:a1e0::1",
            "100.64.0.2"
          ])
        }
      }),
      whois: () => Effect.die("unused")
    }
    return discoverFleetPeers("SER8", [
      { host: "SER8", nodeId: "node-ser8" },
      { host: "PI", nodeId: "node-pi" }
    ]).pipe(
      Effect.provideService(Tailscale, client),
      Effect.tap((peers) =>
        Effect.sync(() => {
          expect(peers).toEqual([
            { host: "PI", ipv4: "100.64.0.2", online: false }
          ])
        })
      )
    )
  })

  it.effect("resolves configured hosts only by stable node identity", () => {
    const client: TailscaleClient = {
      ipv4: Effect.succeed("100.64.0.1"),
      status: Effect.succeed({
        Self: node("SER8", "node-ser8", true, ["100.64.0.1"]),
        Peer: {
          real: node("PI", "node-pi", true, ["100.64.0.2"]),
          spoof: node("PI", "attacker-node", true, ["100.64.0.9"])
        }
      }),
      whois: () => Effect.die("unused")
    }
    return Effect.gen(function*() {
      expect(
        yield* discoverFleetPeers("SER8", [
          { host: "SER8", nodeId: "node-ser8" },
          { host: "PI", nodeId: "node-pi" }
        ])
      ).toEqual([{ host: "PI", ipv4: "100.64.0.2", online: true }])

      const missing = yield* Effect.result(
        discoverFleetPeers("SER8", [
          { host: "SER8", nodeId: "node-ser8" },
          { host: "MAC", nodeId: "node-mac" }
        ])
      )
      expect(missing).toMatchObject({
        failure: {
          _tag: "HerdrTailscale.FleetIdentityError",
          host: "MAC",
          reason: "missing"
        }
      })

      const mismatchedClient: TailscaleClient = {
        ...client,
        status: Effect.succeed({
          Self: node("SER8", "node-ser8", true, ["100.64.0.1"]),
          Peer: {
            renamed: node("WRONG", "node-pi", true, ["100.64.0.2"])
          }
        })
      }
      const mismatch = yield* Effect.result(
        discoverFleetPeers("SER8", [
          { host: "SER8", nodeId: "node-ser8" },
          { host: "PI", nodeId: "node-pi" }
        ]).pipe(Effect.provideService(Tailscale, mismatchedClient))
      )
      expect(mismatch).toMatchObject({
        failure: { reason: "host_mismatch" }
      })

      const duplicateClient: TailscaleClient = {
        ...client,
        status: Effect.succeed({
          Self: node("SER8", "node-ser8", true, ["100.64.0.1"]),
          Peer: {
            first: node("PI", "node-pi", true, ["100.64.0.2"]),
            second: node("PI", "node-pi", true, ["100.64.0.3"])
          }
        })
      }
      const duplicate = yield* Effect.result(
        discoverFleetPeers("SER8", [
          { host: "SER8", nodeId: "node-ser8" },
          { host: "PI", nodeId: "node-pi" }
        ]).pipe(Effect.provideService(Tailscale, duplicateClient))
      )
      expect(duplicate).toMatchObject({
        failure: { reason: "duplicate" }
      })
    }).pipe(Effect.provideService(Tailscale, client))
  })

  it.effect("requires both the allowed login and the expected node", () =>
    authorizeWhois(
      { Node: { StableID: "node-a" }, UserProfile: { LoginName: "andrey@example.com" } },
      ["andrey@example.com"],
      ["node-b"]
    ).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => expect(error).toMatchObject({ _tag: "HerdrTailscale.AuthorizationError" }))
      )
    ))
})

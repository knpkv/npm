import { Context, Effect, Layer, Schema, SchemaGetter, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { isIPv4, isIPv6 } from "node:net"

const BoundedName = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
export const TailIpv4 = Schema.String.check(
  Schema.makeFilter(
    (address) => isIPv4(address) && address !== "0.0.0.0",
    { expected: "a specified IPv4 address" }
  )
)
export const TailIp = Schema.String.check(
  Schema.makeFilter(
    (address) =>
      (isIPv4(address) && address !== "0.0.0.0") ||
      (isIPv6(address) && address !== "::"),
    { expected: "a specified IPv4 or IPv6 address" }
  )
)

export const TailNode = Schema.Struct({
  DNSName: Schema.optionalKey(Schema.String),
  HostName: BoundedName,
  ID: BoundedName,
  Online: Schema.Boolean,
  TailscaleIPs: Schema.Array(TailIp)
})
export interface TailNode extends Schema.Schema.Type<typeof TailNode> {}

const TailPeers = Schema.NullOr(Schema.Record(Schema.String, TailNode)).pipe(
  Schema.decodeTo(Schema.Record(Schema.String, TailNode), {
    decode: SchemaGetter.transform((peers) => peers ?? {}),
    encode: SchemaGetter.transform((peers) => peers)
  })
)

export const TailStatus = Schema.Struct({
  Peer: TailPeers,
  Self: TailNode
})
export interface TailStatus extends Schema.Schema.Type<typeof TailStatus> {}

export const TailWhois = Schema.Struct({
  Node: Schema.Struct({ StableID: BoundedName }),
  UserProfile: Schema.Struct({ LoginName: BoundedName })
})
export interface TailWhois extends Schema.Schema.Type<typeof TailWhois> {}

export const FleetPeer = Schema.Struct({
  host: BoundedName,
  ipv4: Schema.NullOr(TailIpv4),
  online: Schema.Boolean
})
export interface FleetPeer extends Schema.Schema.Type<typeof FleetPeer> {}

export class TailscaleCommandError extends Schema.TaggedError<TailscaleCommandError>()(
  "HerdrTailscale.CommandError",
  { cause: Schema.Defect(), operation: Schema.String }
) {}

export class TailscaleDecodeError extends Schema.TaggedError<TailscaleDecodeError>()(
  "HerdrTailscale.DecodeError",
  { cause: Schema.Defect(), operation: Schema.String }
) {}

export class TailscaleAuthorizationError extends Schema.TaggedError<TailscaleAuthorizationError>()(
  "HerdrTailscale.AuthorizationError",
  { actor: Schema.String }
) {}

export class TailscaleFleetIdentityError extends Schema.TaggedError<TailscaleFleetIdentityError>()(
  "HerdrTailscale.FleetIdentityError",
  {
    host: BoundedName,
    nodeId: BoundedName,
    reason: Schema.Literals(["duplicate", "host_mismatch", "missing"])
  }
) {}

export interface ConfiguredFleetNode {
  readonly host: string
  readonly nodeId: string
}

export interface TailscaleClient {
  readonly ipv4: Effect.Effect<string, TailscaleCommandError | TailscaleDecodeError>
  readonly status: Effect.Effect<TailStatus, TailscaleCommandError | TailscaleDecodeError>
  readonly whois: (
    address: string
  ) => Effect.Effect<TailWhois, TailscaleCommandError | TailscaleDecodeError>
}

interface CollectedOutput {
  readonly bytes: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

export class Tailscale extends Context.Service<Tailscale, TailscaleClient>()(
  "@knpkv/herdr-tailscale/Tailscale"
) {}

const decodeJson = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown, never, never>,
  output: string
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(JSON.parse(output)),
    catch: (cause) => new TailscaleDecodeError({ cause, operation })
  })

const run = Effect.fn("HerdrTailscale.run")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  executable: string,
  operation: string,
  args: ReadonlyArray<string>
) {
  const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
    stream.pipe(
      Stream.mapError((cause) => new TailscaleCommandError({ cause, operation })),
      Stream.runFoldEffect(
        (): CollectedOutput => ({ bytes: 0, chunks: [] }),
        (output, chunk) => {
          const bytes = output.bytes + chunk.byteLength
          return bytes > 1024 * 1024
            ? Effect.fail(
              new TailscaleCommandError({
                cause: bytes,
                operation: `${operation}.output_limit`
              })
            )
            : Effect.succeed({ bytes, chunks: [...output.chunks, chunk] })
        }
      ),
      Effect.flatMap((output) =>
        Stream.fromIterable(output.chunks).pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.mapError((cause) => new TailscaleCommandError({ cause, operation }))
        )
      )
    )
  return yield* Effect.scoped(
    spawner.spawn(ChildProcess.make(executable, args)).pipe(
      Effect.mapError((cause) => new TailscaleCommandError({ cause, operation })),
      Effect.flatMap((handle) =>
        Effect.all({
          exitCode: handle.exitCode.pipe(
            Effect.mapError((cause) => new TailscaleCommandError({ cause, operation }))
          ),
          stderr: collect(handle.stderr),
          stdout: collect(handle.stdout)
        }, { concurrency: "unbounded" })
      ),
      Effect.flatMap(({ exitCode, stderr, stdout }) =>
        Number(exitCode) === 0
          ? Effect.succeed(stdout)
          : Effect.fail(
            new TailscaleCommandError({
              cause: { exitCode, stderr },
              operation
            })
          )
      ),
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () =>
          Effect.fail(
            new TailscaleCommandError({
              cause: "10 seconds",
              operation: `${operation}.timeout`
            })
          )
      })
    )
  )
})

export const make = Effect.fn("HerdrTailscale.make")(function*(executable: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const status = run(spawner, executable, "tailscale.status", ["status", "--json"]).pipe(
    Effect.flatMap((output) => decodeJson("tailscale.status.decode", TailStatus, output))
  )

  const whois = Effect.fn("HerdrTailscale.whois")(function*(address: string) {
    const output = yield* run(spawner, executable, "tailscale.whois", ["whois", "--json", address])
    return yield* decodeJson("tailscale.whois.decode", TailWhois, output)
  })

  const ipv4 = run(spawner, executable, "tailscale.ipv4", ["ip", "-4"]).pipe(
    Effect.map((output) => output.trim()),
    Effect.flatMap((address) =>
      Schema.decodeUnknownEffect(TailIpv4)(address).pipe(
        Effect.mapError(
          (cause) =>
            new TailscaleDecodeError({
              cause,
              operation: "tailscale.ipv4"
            })
        )
      )
    )
  )

  return Tailscale.of({ ipv4, status, whois })
})

export const layer = (executable: string) => Layer.effect(Tailscale, make(executable))

export const nodeIpv4 = (node: TailNode): string | undefined => node.TailscaleIPs.find(isIPv4)

export const resolveFleetNode = Effect.fn("HerdrTailscale.resolveFleetNode")(function*(
  status: TailStatus,
  machine: ConfiguredFleetNode
) {
  const matches = [status.Self, ...Object.values(status.Peer)].filter(
    ({ ID }) => ID === machine.nodeId
  )
  const node = matches[0]
  if (node === undefined) {
    return yield* new TailscaleFleetIdentityError({
      host: machine.host,
      nodeId: machine.nodeId,
      reason: "missing"
    })
  }
  if (matches.length !== 1) {
    return yield* new TailscaleFleetIdentityError({
      host: machine.host,
      nodeId: machine.nodeId,
      reason: "duplicate"
    })
  }
  if (node.HostName.toLowerCase() !== machine.host.toLowerCase()) {
    return yield* new TailscaleFleetIdentityError({
      host: machine.host,
      nodeId: machine.nodeId,
      reason: "host_mismatch"
    })
  }
  return node
})

export const discoverFleetPeers = Effect.fn("HerdrTailscale.discoverFleetPeers")(function*(
  localHost: string,
  machines: ReadonlyArray<ConfiguredFleetNode>
) {
  const tailscale = yield* Tailscale
  const status = yield* tailscale.status
  const resolved = yield* Effect.forEach(machines, (machine) =>
    resolveFleetNode(status, machine).pipe(
      Effect.map(
        (node): FleetPeer => ({
          host: machine.host,
          ipv4: nodeIpv4(node) ?? null,
          online: node.Online
        })
      )
    ))
  return resolved.filter(
    ({ host }) => host.toLowerCase() !== localHost.toLowerCase()
  )
})

export const authorizeWhois = Effect.fn("HerdrTailscale.authorizeWhois")(function*(
  identity: TailWhois,
  allowedUsers: ReadonlyArray<string>,
  requiredNodeIds: ReadonlyArray<string> | null
) {
  const login = identity.UserProfile.LoginName
  if (!allowedUsers.includes(login)) {
    return yield* new TailscaleAuthorizationError({ actor: login })
  }
  if (requiredNodeIds !== null && !requiredNodeIds.includes(identity.Node.StableID)) {
    return yield* new TailscaleAuthorizationError({ actor: identity.Node.StableID })
  }
  return login
})

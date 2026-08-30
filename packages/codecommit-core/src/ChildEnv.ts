/**
 * Environment construction for profile-scoped child processes.
 *
 * Tools we spawn (`git` with the `aws codecommit credential-helper`, and
 * `assume`) are told which AWS profile to use explicitly. They still need the
 * caller's `PATH`, so they run with `extendEnv: true` — which also inherits any
 * ambient AWS credentials the caller happens to export.
 *
 * That inheritance is not benign. The AWS credential chain resolves environment
 * variables *above* profile configuration, so an ambient `AWS_ACCESS_KEY_ID`
 * silently wins over the profile we asked for and the command authenticates as
 * the wrong identity. Both region variables override the profile's configured
 * region the same way.
 *
 * `profileScopedEnv` removes those variables so the named profile is the only
 * credential and region source, and callers reintroduce a region only by passing
 * it explicitly. Mapping a name to `undefined` drops it from the child
 * environment rather than setting it to the string `"undefined"` — verified on
 * both Node and Bun, the two runtimes this CLI ships on.
 */

/**
 * Credential and region variables that outrank profile configuration.
 *
 * Two environment credential providers sit above the profile in the chain, so
 * both have to be cleared:
 *
 * - Static credentials, including `AWS_SECURITY_TOKEN` — the legacy alias for
 *   `AWS_SESSION_TOKEN`, still honoured by the CLI.
 * - Web identity, which activates from `AWS_ROLE_ARN` plus
 *   `AWS_WEB_IDENTITY_TOKEN_FILE` and would otherwise assume an ambient role.
 *
 * Both `AWS_REGION` and `AWS_DEFAULT_REGION` are cleared. Clearing only one is
 * worse than clearing neither, because which variable leaks through then depends
 * on the caller's shell rather than on anything this module states.
 *
 * Deliberately *not* cleared:
 *
 * - `AWS_CONTAINER_CREDENTIALS_*` and IMDS resolve *below* the shared config
 *   file, so they cannot outrank an explicit profile.
 * - `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` select which file the
 *   profile is read from. The parent resolved the profile name against those
 *   same paths, so clearing them would point the child at a different file and
 *   break legitimate custom config locations.
 *
 * CASE INSENSITIVITY. Clearing works by mapping each name to `undefined` in an
 * object merged over the inherited environment, and that merge matches keys
 * exactly. Windows environment names are case-insensitive, so a host exporting
 * `Aws_Access_Key_Id` would keep that entry alive beside the `AWS_ACCESS_KEY_ID`
 * tombstone and the AWS CLI could still read it. `profileScopedEnv` therefore
 * takes the inherited environment and tombstones the spellings actually present
 * as well as the canonical names, which closes the gap without taking `PATH` and
 * every other inherited variable into this module's hands: the spawn stays
 * `extendEnv: true`.
 *
 * The folding is unconditional, on every platform. On POSIX a lowercase
 * `aws_access_key_id` is a genuinely distinct variable that the AWS chain never
 * reads, so dropping it is broader than strictly required — deliberately, because
 * detecting a case-insensitive host would mean reading the platform from this
 * module, and a variable differing only in case carries the same intent. Nothing
 * we spawn (`git`, `aws`, `assume`, `docker`) reads the lowercase spellings.
 */
import { Context, Layer } from "effect"

const OVERRIDING_AWS_VARIABLES: ReadonlyArray<string> = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_CREDENTIAL_EXPIRATION",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_SESSION_NAME",
  "AWS_REGION",
  "AWS_DEFAULT_REGION"
]

const REPOSITORY_CONTROL_GIT_VARIABLES: ReadonlyArray<string> = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE"
]

/** Whether an inherited name denotes an overriding AWS variable under any casing. */
const isOverridingAwsVariable = (name: string): boolean => {
  // `toUpperCase`, not `toLocaleUpperCase`: these names are ASCII and a Turkish
  // locale would fold `AWS_..._ID` differently, reintroducing the gap it closes.
  const canonical = name.toUpperCase()
  return OVERRIDING_AWS_VARIABLES.some((candidate) => candidate === canonical)
}

/**
 * Builds a child environment where `overrides` are the only AWS credential and
 * region inputs, dropping any ambient values that would outrank them.
 *
 * `inherited` is the environment the child will extend. It is read only to find
 * which spellings of the overriding names are actually present, so a
 * case-insensitive host cannot keep `Aws_Access_Key_Id` alive beside the
 * canonical tombstone. Pass the environment the spawn will really inherit —
 * `HostEnvironment.variables` at a runtime call site.
 *
 * Must be paired with `extendEnv: true`; on its own it does not carry `PATH`.
 *
 * @example
 * ```ts
 * const host = yield* ChildEnv.HostEnvironment
 * ChildProcess.make("git", args, {
 *   env: ChildEnv.profileScopedEnv(host.variables, { AWS_PROFILE: profile }),
 *   extendEnv: true
 * })
 * ```
 */
export const profileScopedEnv = (
  inherited: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>
) => {
  const cleared: Record<string, string | undefined> = {}
  for (const name of OVERRIDING_AWS_VARIABLES) {
    cleared[name] = undefined
  }
  for (const name of Object.keys(inherited)) {
    if (isOverridingAwsVariable(name)) cleared[name] = undefined
  }
  return { ...cleared, ...overrides }
}

/**
 * Builds tombstones for repository-control variables exported by Git hooks.
 *
 * A child `git -C <fixture>` must discover the fixture from `-C`. Inheriting a
 * hook's `GIT_DIR` or `GIT_INDEX_FILE` silently binds it to the outer worktree
 * instead. Pass the environment the child will extend so mixed-case spellings
 * are cleared on case-insensitive hosts. Explicit overrides are applied last.
 *
 * Must be paired with `extendEnv: true`; on its own it does not carry `PATH`.
 */
export const gitChildEnv = (
  inherited: Record<string, string | undefined>,
  overrides: Record<string, string | undefined> = {}
) => {
  const cleared: Record<string, string | undefined> = {}
  for (const name of REPOSITORY_CONTROL_GIT_VARIABLES) {
    cleared[name] = undefined
  }
  for (const name of Object.keys(inherited)) {
    const canonical = name.toUpperCase()
    if (
      REPOSITORY_CONTROL_GIT_VARIABLES.some((candidate) => candidate === canonical) ||
      canonical.startsWith("GIT_CONFIG_KEY_") ||
      canonical.startsWith("GIT_CONFIG_VALUE_")
    ) {
      cleared[name] = undefined
    }
  }
  return { ...cleared, ...overrides }
}

/**
 * The environment a spawned child will inherit.
 *
 * A service rather than a direct read because only the executable boundary may
 * touch the host process, while the spawns that need it sit deep in the runtime.
 */
export class HostEnvironment extends Context.Service<HostEnvironment, {
  readonly variables: Record<string, string | undefined>
}>()("@knpkv/codecommit-core/ChildEnv/HostEnvironment") {}

/** Binds the inherited environment read at the executable boundary. */
export const layerHostEnvironment = (
  variables: Record<string, string | undefined>
): Layer.Layer<HostEnvironment> => Layer.succeed(HostEnvironment, HostEnvironment.of({ variables }))

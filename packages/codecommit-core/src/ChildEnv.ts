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
 * KNOWN LIMITATION — Windows casing. Clearing works by mapping each name to
 * `undefined` in an object merged over the inherited environment, which matches
 * keys exactly. Windows environment names are case-insensitive, so a host
 * exporting `Aws_Access_Key_Id` keeps that entry alongside the `AWS_ACCESS_KEY_ID`
 * tombstone and the AWS CLI can still read it. Closing this means filtering the
 * inherited keys case-insensitively, which requires enumerating the parent
 * environment; no Effect service exposes that here, and `globalThis.process` is
 * not available to this code. The two `assume` call sites are POSIX-only in
 * practice — their clipboard step has only `pbcopy` and `xclip` — so the exposed
 * path is the SandboxService clone on a Windows host. Tracked rather than
 * silently accepted; the exact-case behaviour these tests cover is correct on
 * POSIX.
 */
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

/**
 * Builds a child environment where `overrides` are the only AWS credential and
 * region inputs, dropping any ambient values that would outrank them.
 *
 * Must be paired with `extendEnv: true`; on its own it does not carry `PATH`.
 *
 * @example
 * ```ts
 * ChildProcess.make("git", args, {
 *   env: ChildEnv.profileScopedEnv({ AWS_PROFILE: profile }),
 *   extendEnv: true
 * })
 * ```
 */
export const profileScopedEnv = (
  overrides: Record<string, string | undefined>
): Record<string, string | undefined> => {
  const cleared: Record<string, string | undefined> = {}
  for (const name of OVERRIDING_AWS_VARIABLES) {
    cleared[name] = undefined
  }
  return { ...cleared, ...overrides }
}

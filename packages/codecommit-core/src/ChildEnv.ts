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
 * the wrong identity. `AWS_REGION` outranks `AWS_DEFAULT_REGION` the same way.
 *
 * `profileScopedEnv` removes those variables so the named profile is the only
 * credential source. Mapping a name to `undefined` drops it from the child
 * environment rather than setting it to the string `"undefined"` — verified on
 * both Node and Bun, the two runtimes this CLI ships on.
 */

/**
 * Credential and region variables that outrank profile configuration.
 *
 * `AWS_SECURITY_TOKEN` is the legacy alias for `AWS_SESSION_TOKEN` and is still
 * honoured by the CLI, so it has to be cleared alongside it.
 */
const OVERRIDING_AWS_VARIABLES: ReadonlyArray<string> = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_CREDENTIAL_EXPIRATION",
  "AWS_REGION"
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

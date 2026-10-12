import * as ChildEnv from "@knpkv/codecommit-core/ChildEnv.js"

/** Clear inherited provider inputs under their actual spelling before applying fixture-owned paths. */
export const visualChildEnv = (
  inherited: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>
) => {
  const cleared = ChildEnv.profileScopedEnv(inherited, { AWS_PROFILE: undefined, AWS_DEFAULT_PROFILE: undefined })
  for (const name of Object.keys(inherited)) {
    const canonical = name.toUpperCase()
    if (
      canonical.startsWith("AWS_") || canonical.startsWith("ATLASSIAN_") || canonical.startsWith("CLOCKIFY_") ||
      canonical.startsWith("CONTROL_CENTER_")
    ) cleared[name] = undefined
  }
  return { ...cleared, ...overrides }
}

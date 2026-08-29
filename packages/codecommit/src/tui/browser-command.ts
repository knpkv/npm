import { Schema } from "effect"

/**
 * A region whose partition has no console hostname this build knows.
 *
 * Lives beside {@link codecommitPullRequestConsoleUrl} because it is the name
 * for that function's `null`: a caller that turns the null into a failure needs
 * both, and keeping them apart lets one drift from the other.
 */
export class UnsupportedConsoleRegion extends Schema.TaggedError<UnsupportedConsoleRegion>()(
  "UnsupportedConsoleRegion",
  {
    region: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Builds the Granted arguments for opening an exact console destination.
 * `--cd` is a long-option alias; `-cd` is parsed as `-c` plus `-d`.
 */
export const assumeConsoleArgs = (link: string, profile: string): ReadonlyArray<string> => ["--cd", link, profile]

/**
 * Console hostnames by AWS partition.
 *
 * The console lives on a different domain per partition, and it is not the same
 * mapping as the Git endpoint suffixes in `WorktreeService` — those name the
 * service endpoint, these name the web console. Order matters: `us-gov-…` also
 * matches the commercial pattern, so it is tested first.
 *
 * Isolated partitions (`us-iso*`, `eu-isoe-*`, `eusc-de-*`) are deliberately
 * absent. Their console hostnames are not something to guess at, and emitting a
 * plausible-looking wrong URL is worse than declining: the caller reports the
 * region as unsupported instead.
 */
const AWS_CONSOLE_HOSTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^cn-[a-z0-9-]+-\d+$/u, "console.amazonaws.cn"],
  [/^us-gov-[a-z0-9-]+-\d+$/u, "console.amazonaws-us-gov.com"],
  [/^(?:us|eu|ap|sa|ca|me|af|il|mx)-[a-z0-9-]+-\d+$/u, "console.aws.amazon.com"]
]

/**
 * Isolated partitions, declined before the commercial pattern is consulted.
 *
 * They have to be matched first because the commercial pattern also accepts them:
 * `us-iso-east-1` satisfies `^us-[a-z0-9-]+-\d+$`, so ordering is what keeps an
 * isolated region from being handed a commercial hostname.
 */
const UNSUPPORTED_CONSOLE_REGIONS: ReadonlyArray<RegExp> = [
  /^us-isob-[a-z0-9-]+-\d+$/u,
  /^us-isof-[a-z0-9-]+-\d+$/u,
  /^us-iso-[a-z0-9-]+-\d+$/u,
  /^eu-isoe-[a-z0-9-]+-\d+$/u,
  /^eusc-de-[a-z0-9-]+-\d+$/u
]

/** Resolves the console hostname for a region, or null when the partition is unsupported. */
export const codecommitConsoleHost = (region: string): string | null =>
  UNSUPPORTED_CONSOLE_REGIONS.some((pattern) => pattern.test(region))
    ? null
    : AWS_CONSOLE_HOSTS.find(([pattern]) => pattern.test(region))?.[1] ?? null

/**
 * Builds the CodeCommit console destination for one pull request.
 *
 * Partition-aware, unlike `Domain.codecommitConsoleUrl`, which hardcodes the
 * commercial hostname. Returns null for a region whose partition has no known
 * console host, so an unusable link is never handed to `assume`.
 */
export const codecommitPullRequestConsoleUrl = (input: {
  readonly prId: string
  readonly region: string
  readonly repositoryName: string
}): string | null => {
  const host = codecommitConsoleHost(input.region)
  if (host === null) return null
  const repository = encodeURIComponent(input.repositoryName)
  const pullRequest = encodeURIComponent(input.prId)
  const region = encodeURIComponent(input.region)
  return `https://${region}.${host}/codesuite/codecommit/repositories/${repository}/pull-requests/${pullRequest}?region=${region}`
}

/**
 * Builds the CodeCommit console destination for one reviewed file.
 *
 * The console addresses a blob as `browse/{commitId}/--/{path}`, so pinning the
 * commit in the path keeps the opened page on the revision the TUI reviewed even
 * if the branch advances afterwards. Path segments are encoded individually so
 * the `/` separators the console parses survive while each segment stays safe.
 *
 * Returns null for a region whose partition has no known console host, so an
 * unusable link is never handed to `assume`.
 */
export const codecommitFileConsoleUrl = (input: {
  readonly commitId: string
  readonly filePath: string
  readonly region: string
  readonly repositoryName: string
}): string | null => {
  const host = codecommitConsoleHost(input.region)
  if (host === null) return null
  const encodedPath = input.filePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/")
  const repository = encodeURIComponent(input.repositoryName)
  const commit = encodeURIComponent(input.commitId)
  const region = encodeURIComponent(input.region)
  return `https://${region}.${host}/codesuite/codecommit/repositories/${repository}/browse/${commit}/--/${encodedPath}?region=${region}`
}

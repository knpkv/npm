/**
 * Builds the Granted arguments for opening an exact console destination.
 * `--cd` is a long-option alias; `-cd` is parsed as `-c` plus `-d`.
 */
export const assumeConsoleArgs = (link: string, profile: string): ReadonlyArray<string> => ["--cd", link, profile]

/**
 * Builds the CodeCommit console destination for one reviewed file.
 *
 * The console addresses a blob as `browse/{commitId}/--/{path}`, so pinning the
 * commit in the path keeps the opened page on the revision the TUI reviewed even
 * if the branch advances afterwards. Path segments are encoded individually so
 * the `/` separators the console parses survive while each segment stays safe.
 */
export const codecommitFileConsoleUrl = (input: {
  readonly commitId: string
  readonly filePath: string
  readonly region: string
  readonly repositoryName: string
}): string => {
  const encodedPath = input.filePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/")
  const repository = encodeURIComponent(input.repositoryName)
  const commit = encodeURIComponent(input.commitId)
  const region = encodeURIComponent(input.region)
  return `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repository}/browse/${commit}/--/${encodedPath}?region=${region}`
}

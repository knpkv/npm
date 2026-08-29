/**
 * Recognising what a Git remote URL says about a CodeCommit repository.
 *
 * Pure string work, deliberately kept apart from the command that consumes it:
 * the remote forms are a CodeCommit fact, not a `pr open` fact, and they are the
 * one part of that command worth exhaustively testing without a spawner, an AWS
 * client or a runtime.
 *
 * @category Domain
 * @module
 */
import { Schema } from "effect"

export class NotACodeCommitRemote extends Schema.TaggedError<NotACodeCommitRemote>()(
  "NotACodeCommitRemote",
  {
    remoteUrl: Schema.String,
    message: Schema.String
  }
) {}

/**
 * What a CodeCommit remote URL discloses.
 *
 * `region` is absent only for the region-less `codecommit://` Git-remote-codecommit
 * form. Any embedded profile is deliberately dropped: it is a local alias for
 * whoever cloned the repository, and the scan resolves the account that holds the
 * PR anyway, so honouring it would add a second code path that can disagree.
 */
export interface CodeCommitRemote {
  readonly region: string | null
  readonly repositoryName: string
}

/**
 * The remote forms CodeCommit hands out, in the order they are tried.
 *
 * HTTPS and SSH share a shape and both carry the region in the host. The two
 * `codecommit::`/`codecommit://` forms come from git-remote-codecommit, where the
 * authority is the repository name rather than a host, and only the first names a
 * region.
 */
const REMOTE_PATTERNS: ReadonlyArray<
  readonly [RegExp, (match: RegExpMatchArray) => CodeCommitRemote]
> = [
  [
    /^(?:https?|ssh):\/\/(?:[^@/]+@)?git-codecommit(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/(.+)$/u,
    (match) => ({ region: match[1] ?? null, repositoryName: match[2] ?? "" })
  ],
  [
    /^codecommit::([a-z0-9-]+):\/\/(?:[^@/]+@)?(.+)$/u,
    (match) => ({ region: match[1] ?? null, repositoryName: match[2] ?? "" })
  ],
  [
    /^codecommit:\/\/(?:[^@/]+@)?(.+)$/u,
    (match) => ({ region: null, repositoryName: match[1] ?? "" })
  ]
]

/**
 * Recognises a CodeCommit remote and extracts what it names.
 *
 * Returns null for anything else — an Azure DevOps or GitHub remote is a plain
 * "not this tool's business", and answering it with null keeps a cross-account
 * scan from running for a repository no CodeCommit account can hold.
 */
export const parseCodeCommitRemote = (remoteUrl: string): CodeCommitRemote | null => {
  const trimmed = remoteUrl.trim()
  for (const [pattern, extract] of REMOTE_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match === null) continue
    const parsed = extract(match)
    const repositoryName = parsed.repositoryName.replace(/\/+$/u, "").replace(/\.git$/u, "")
    if (repositoryName === "") return null
    return { region: parsed.region, repositoryName }
  }
  return null
}

/**
 * Blanks the userinfo component of a remote URL before it is shown to anyone.
 *
 * A remote that is not CodeCommit gets echoed back so the caller can see what
 * was found there, and Git remotes routinely carry a credential in that
 * position (`https://user:ghp_...@host/org/repo.git`, and the Azure DevOps PAT
 * URLs this rejects in practice). The patterns above already discard userinfo,
 * so the rejection path is the only one that can print one — into a terminal
 * scrollback or the popup `pr open` is built around.
 *
 * The scp-like `git@host:org/repo` form has no `//`, so it is left alone: that
 * userinfo is a login name, not a secret.
 */
export const redactRemoteUserInfo = (remoteUrl: string): string =>
  remoteUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/iu, "$1***@")

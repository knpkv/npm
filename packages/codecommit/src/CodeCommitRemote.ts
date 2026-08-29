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
import { Domain } from "@knpkv/codecommit-core"
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"

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
 * `region` is absent only for the region-less `codecommit://`
 * Git-remote-codecommit form. `profile` is present only when that helper URL
 * names one; it is an exact local account discriminator and narrows the scan.
 */
export interface CodeCommitRemote {
  readonly profile: string | null
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
    /^(?:https?|ssh):\/\/(?:[^@/]+@)?git-codecommit(?:-fips)?\.([a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/([A-Za-z0-9._-]{1,100})\/*$/u,
    (match) => ({ profile: null, region: match[1] ?? null, repositoryName: match[2] ?? "" })
  ],
  [
    /^codecommit::([a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+):\/\/(?:([^@/]+)@)?([A-Za-z0-9._-]{1,100})$/u,
    (match) => ({ profile: match[2] ?? null, region: match[1] ?? null, repositoryName: match[3] ?? "" })
  ],
  [
    /^codecommit:\/\/(?:([^@/]+)@)?([A-Za-z0-9._-]{1,100})$/u,
    (match) => ({ profile: match[1] ?? null, region: null, repositoryName: match[2] ?? "" })
  ]
]

const RemoteRegion = Domain.AwsRegion.check(
  Schema.isPattern(/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/u)
)
const RemoteRepositoryName = Domain.RepositoryName.check(
  Schema.isPattern(/^[A-Za-z0-9._-]{1,100}$/u)
)
const isTerminalSafeCharacter = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0
  return code >= 0x20 && (code < 0x7f || code > 0x9f)
}
const RemoteProfile = Schema.String.check(
  Schema.isPattern(/^[^@/]+$/u),
  Schema.makeFilter(
    (profile) => [...profile].every(isTerminalSafeCharacter),
    { expected: "a profile name without control characters" }
  )
)
const CodeCommitRemoteValue = Schema.Struct({
  profile: Schema.NullOr(RemoteProfile),
  region: Schema.NullOr(RemoteRegion),
  repositoryName: RemoteRepositoryName
})

const parseRemoteString = (remoteUrl: string): CodeCommitRemote | null => {
  const trimmed = remoteUrl.trim()
  for (const [pattern, extract] of REMOTE_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match !== null) return extract(match)
  }
  return null
}

const CodeCommitRemoteFromString = Schema.String.pipe(
  Schema.decodeTo(CodeCommitRemoteValue, {
    decode: SchemaGetter.transformOrFail((input, options) => {
      const parsed = parseRemoteString(input)
      return parsed === null
        ? Effect.fail(new SchemaIssue.InvalidValue({ expected: "a CodeCommit Git remote URL" }, input, options))
        : Effect.succeed(parsed)
    }),
    encode: SchemaGetter.transform(({ profile, region, repositoryName }) => {
      const authority = profile === null ? repositoryName : `${profile}@${repositoryName}`
      return region === null ? `codecommit://${authority}` : `codecommit::${region}://${authority}`
    })
  })
)

const decodeCodeCommitRemote = Schema.decodeUnknownOption(CodeCommitRemoteFromString)

/**
 * Recognises a CodeCommit remote and extracts what it names.
 *
 * Returns null for anything else — an Azure DevOps or GitHub remote is a plain
 * "not this tool's business", and answering it with null keeps a cross-account
 * scan from running for a repository no CodeCommit account can hold.
 */
export const parseCodeCommitRemote = (remoteUrl: string): CodeCommitRemote | null => {
  const decoded = decodeCodeCommitRemote(remoteUrl)
  return Option.isSome(decoded) ? decoded.value : null
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
export const redactRemoteUserInfo = (remoteUrl: string): string => {
  const terminalSafe = [...remoteUrl].filter(isTerminalSafeCharacter).join("")
  return terminalSafe.replace(/^( *)([a-z][a-z0-9+.-]*:\/\/)[^/]*@/iu, "$1$2***@")
}

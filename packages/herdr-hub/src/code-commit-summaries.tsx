/**
 * Gives every CommitLabel on a Code page its title and time from the host. Without a selected pull
 * request there is nothing to read, so labels say the title is unavailable. "Today" is the day of the
 * queue reading the page shows (`observedAt`), so a label reads the same however late it is viewed.
 *
 *   <CodeCommitSummaries observedAt={queue.observedAt} reads={reads} reference={ref}>…</CodeCommitSummaries>
 *
 * @module
 */
import type { CodeReference } from "@knpkv/codecommit-web/host"
import { CommitSummaryProvider, useCommitSummaries } from "@knpkv/review/react"
import { Effect } from "effect"
import { type ReactElement, type ReactNode, useCallback } from "react"
import { type CodeModuleReads, CodeReadFailed } from "./code-client.js"

interface SummariesProps {
  readonly children: ReactNode
  /** When the page's reading was taken; null when there is none yet. */
  readonly observedAt: number | null
  readonly reads: CodeModuleReads
  readonly reference: CodeReference | null
}

/** One set of summaries per pull request: a new selection gets a new loader, which starts afresh. */
export const CodeCommitSummaries = ({ children, observedAt, reads, reference }: SummariesProps): ReactElement => {
  const load = useCallback(
    (commit: string) =>
      Effect.runPromise(
        reference === null
          ? Effect.fail(new CodeReadFailed({ reason: "not_found" }))
          : reads
              .commit({ ref: reference, commit })
              .pipe(
                Effect.flatMap((result) =>
                  result._tag === "Ready"
                    ? Effect.succeed({ title: result.commit.title, committedAt: result.commit.committedAt })
                    : Effect.fail(new CodeReadFailed({ reason: "status" }))
                )
              )
      ),
    [reads.commit, reference]
  )
  return <CommitSummaryProvider source={useCommitSummaries(load, observedAt)}>{children}</CommitSummaryProvider>
}

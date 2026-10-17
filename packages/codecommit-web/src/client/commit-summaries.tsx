/**
 * Gives every CommitLabel on a pull request's page its title and time from the owner API. Each commit
 * a label asks for gets one query atom; a failed read shows as "Commit title unavailable".
 *
 *   <PullRequestCommitSummaries accountId={accountId} pullRequest={pullRequest}>
 *     …<CommitLabel commit={diff.headCommit} />…
 *   </PullRequestCommitSummaries>
 *
 * @module
 */
import { useAtomValue } from "@effect/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { type CommitSummaryReading, CommitSummaryProvider, type CommitSummarySource } from "@knpkv/review/react"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { ApiClient } from "./atoms/runtime.js"

interface PullRequestCoordinates {
  readonly accountId: string
  readonly pullRequest: Domain.PullRequest
}

const CommitSummaryLoad = ({
  accountId,
  commit,
  onReading,
  pullRequest
}: PullRequestCoordinates & {
  readonly commit: string
  readonly onReading: (commit: string, reading: CommitSummaryReading) => void
}): null => {
  const summaryAtom = useMemo(
    () =>
      ApiClient.query("prs", "commit", {
        params: { awsAccountId: accountId, prId: pullRequest.id, commitId: commit },
        query: { region: pullRequest.account.region, repositoryName: pullRequest.repositoryName },
        timeToLive: "1 hour"
      }),
    [accountId, commit, pullRequest.account.region, pullRequest.id, pullRequest.repositoryName]
  )
  const result = useAtomValue(summaryAtom)
  useEffect(() => {
    onReading(
      commit,
      AsyncResult.isSuccess(result)
        ? { _tag: "Ready", title: result.value.title, committedAt: result.value.committedAt }
        : AsyncResult.isFailure(result)
          ? { _tag: "Unavailable" }
          : { _tag: "Loading" }
    )
  }, [commit, onReading, result])
  return null
}

export const PullRequestCommitSummaries = ({
  accountId,
  children,
  pullRequest
}: PullRequestCoordinates & { readonly children: ReactNode }): ReactElement => {
  const [requested, setRequested] = useState<ReadonlyArray<string>>([])
  const [readings, setReadings] = useState<ReadonlyMap<string, CommitSummaryReading>>(new Map())
  // A page's "today" is the day it opened; labels are absolute times, so they never need a ticking clock.
  const [now] = useState(() => Date.now())
  const request = useCallback(
    (commit: string) => setRequested((current) => (current.includes(commit) ? current : [...current, commit])),
    []
  )
  const onReading = useCallback(
    (commit: string, reading: CommitSummaryReading) => setReadings((current) => new Map(current).set(commit, reading)),
    []
  )
  const source = useMemo<CommitSummarySource>(
    () => ({ read: (commit) => readings.get(commit) ?? { _tag: "Loading" }, request, now }),
    [now, readings, request]
  )
  return (
    <CommitSummaryProvider source={source}>
      {children}
      {requested.map((commit) => (
        <CommitSummaryLoad
          accountId={accountId}
          commit={commit}
          key={commit}
          onReading={onReading}
          pullRequest={pullRequest}
        />
      ))}
    </CommitSummaryProvider>
  )
}

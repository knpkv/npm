import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import type { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import * as sts from "distilled-aws/sts"
import { Cause, Context, Effect, Layer, Schedule, Stream } from "effect"
import type { Account, CommentThread, PRComment, PRCommentLocation, PullRequest } from "./Domain.js"

/**
 * Check if error is a throttling exception
 */
const isThrottlingError = (error: unknown): boolean => {
  const errorStr = Cause.pretty(Cause.fail(error)).toLowerCase()
  return errorStr.includes("throttl") ||
    errorStr.includes("rate exceed") ||
    errorStr.includes("too many requests") ||
    errorStr.includes("requestlimitexceeded")
}

/**
 * Retry schedule for throttling: exponential backoff starting at 1s, max 30s, up to 5 retries
 */
const throttleRetrySchedule = Schedule.intersect(
  Schedule.exponential("1 second", 2).pipe(Schedule.jittered),
  Schedule.recurs(5)
).pipe(Schedule.upTo("30 seconds"))

/**
 * Wrap an effect with throttle retry logic
 */
const withThrottleRetry = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry(
      throttleRetrySchedule.pipe(
        Schedule.whileInput((error: E) => isThrottlingError(error))
      )
    )
  )

export class AwsClient extends Context.Tag("AwsClient")<
  AwsClient,
  {
    readonly getPullRequests: (
      account: { profile: string; region: string },
      options?: { status?: "OPEN" | "CLOSED" }
    ) => Stream.Stream<PullRequest, unknown, HttpClient.HttpClient>
    readonly getCallerIdentity: (
      account: { profile: string; region: string }
    ) => Effect.Effect<string, unknown, HttpClient.HttpClient>
    readonly createPullRequest: (params: {
      account: { profile: string; region: string }
      repositoryName: string
      title: string
      description?: string
      sourceReference: string
      destinationReference: string
    }) => Effect.Effect<string, unknown, HttpClient.HttpClient>
    readonly listBranches: (params: {
      account: { profile: string; region: string }
      repositoryName: string
    }) => Effect.Effect<string[], unknown, HttpClient.HttpClient>
    readonly getCommentsForPullRequest: (params: {
      account: { profile: string; region: string }
      pullRequestId: string
      repositoryName: string
    }) => Effect.Effect<PRCommentLocation[], unknown, HttpClient.HttpClient>
    readonly updatePullRequestTitle: (params: {
      account: { profile: string; region: string }
      pullRequestId: string
      title: string
    }) => Effect.Effect<void, unknown, HttpClient.HttpClient>
    readonly updatePullRequestDescription: (params: {
      account: { profile: string; region: string }
      pullRequestId: string
      description: string
    }) => Effect.Effect<void, unknown, HttpClient.HttpClient>
    readonly getPullRequest: (params: {
      account: { profile: string; region: string }
      pullRequestId: string
    }) => Effect.Effect<{
      title: string
      description?: string
      author: string
      status: string
      repositoryName: string
      sourceBranch: string
      destinationBranch: string
      creationDate: Date
    }, unknown, HttpClient.HttpClient>
  }
>() {}

/**
 * Normalize AWS author ARN to a human-readable name (SessionName or Username)
 * e.g. arn:aws:sts::...:assumed-role/Role/SessionName -> SessionName
 */
const normalizeAuthor = (arn: string): string => {
  const parts = arn.split(":")
  const identityPart = parts[parts.length - 1] ?? ""
  const segments = identityPart.split("/")
  return segments[segments.length - 1] || arn
}

export const AwsClientLive = Layer.effect(
  AwsClient,
  Effect.gen(function*() {
    const getPullRequests = (
      account: { profile: string; region: string },
      options?: { status?: "OPEN" | "CLOSED" }
    ): Stream.Stream<PullRequest, unknown, HttpClient.HttpClient> => {
      const status = options?.status ?? "OPEN"
      const stream = codecommit.listRepositories.pages({}).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.repositories ?? [])),
        Stream.map((repo) => repo.repositoryName!),
        Stream.flatMap(
          (repoName) =>
            codecommit.listPullRequests.pages({ repositoryName: repoName, pullRequestStatus: status })
              .pipe(
                Stream.flatMap((page) => Stream.fromIterable(page.pullRequestIds ?? [])),
                Stream.map((id) => ({ id, repoName }))
              ),
          { concurrency: 2 }
        ),
        Stream.mapEffect(({ id, repoName }) =>
          withThrottleRetry(
            Effect.gen(function*() {
              const resp = yield* codecommit.getPullRequest({ pullRequestId: id })
              const pr = resp.pullRequest!
              const revisionId = pr.revisionId!

              const [approvalEval, mergeEval] = yield* Effect.all([
                withThrottleRetry(
                  codecommit.evaluatePullRequestApprovalRules({ pullRequestId: id, revisionId })
                ).pipe(
                  Effect.map((r) => r.evaluation?.approved ?? false),
                  Effect.catchAll(() => Effect.succeed(false))
                ),
                Effect.gen(function*() {
                  const target = pr.pullRequestTargets?.[0]
                  if (!target) return true
                  return yield* withThrottleRetry(
                    codecommit.getMergeConflicts({
                      repositoryName: repoName,
                      destinationCommitSpecifier: target.destinationCommit!,
                      sourceCommitSpecifier: target.sourceCommit!,
                      mergeOption: "THREE_WAY_MERGE"
                    })
                  ).pipe(
                    Effect.map((r) => r.mergeable ?? false),
                    Effect.catchAll(() => Effect.succeed(false))
                  )
                })
              ])

              return {
                ...pr,
                repoName,
                isApproved: approvalEval,
                isMergeable: mergeEval
              }
            })
          ), { concurrency: 3 }),
        Stream.map((pr) => {
          const accountModel: Account = {
            id: account.profile,
            region: account.region
          }

          const link =
            `https://${account.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${pr.repoName}/pull-requests/${pr.pullRequestId}?region=${account.region}`

          const target = pr.pullRequestTargets?.[0]
          const sourceBranch = target?.sourceReference?.split("/").pop() ?? "unknown"
          const destinationBranch = target?.destinationReference?.split("/").pop() ?? "unknown"

          return {
            id: pr.pullRequestId!,
            title: pr.title!,
            description: pr.description,
            author: pr.authorArn ? normalizeAuthor(pr.authorArn) : "unknown",
            repositoryName: pr.repoName,
            creationDate: pr.creationDate!,
            lastModifiedDate: pr.lastActivityDate!,
            link,
            account: accountModel,
            status: pr.pullRequestStatus!,
            sourceBranch,
            destinationBranch,
            isMergeable: pr.isMergeable,
            isApproved: pr.isApproved
          } as PullRequest
        })
      )

      // Use the standard provider chain with the specific profile
      const credentialsEffect = Effect.tryPromise({
        try: () => {
          // If profile is "default", try empty options first to use standard env var logic
          const options = account.profile === "default" ? {} : { profile: account.profile }
          return fromNodeProviderChain(options)()
        },
        catch: (e) => new Error(e instanceof Error ? e.message : String(e))
      }).pipe(
        Effect.map(Credentials.fromAwsCredentialIdentity),
        Effect.mapError((e) => new Error(`Auth failed for ${account.profile}: ${e.message}`)),
        Effect.timeout("5 seconds")
      )

      // Ensure region is correctly typed for distilled-aws
      const streamWithRegion = Stream.provideService(stream, Region.Region, account.region as any)

      return streamWithRegion.pipe(
        Stream.provideServiceEffect(Credentials.Credentials, credentialsEffect),
        Stream.timeout("60 seconds")
      )
    }

    const getCallerIdentity = (
      account: { profile: string; region: string }
    ): Effect.Effect<string, unknown, HttpClient.HttpClient> => {
      const credentialsEffect = Effect.tryPromise({
        try: () => {
          const options = account.profile === "default" ? {} : { profile: account.profile }
          return fromNodeProviderChain(options)()
        },
        catch: (e) => new Error(e instanceof Error ? e.message : String(e))
      }).pipe(
        Effect.map(Credentials.fromAwsCredentialIdentity),
        Effect.mapError((e) => new Error(`Auth failed for ${account.profile}: ${e.message}`)),
        Effect.timeout("5 seconds")
      )

      return sts.getCallerIdentity({}).pipe(
        Effect.map((resp) => normalizeAuthor(resp.Arn ?? "")),
        Effect.provideService(Region.Region, account.region as any),
        Effect.provideServiceEffect(Credentials.Credentials, credentialsEffect),
        Effect.timeout("10 seconds")
      )
    }

    const createPullRequest = (params: {
      account: { profile: string; region: string }
      repositoryName: string
      title: string
      description?: string
      sourceReference: string
      destinationReference: string
    }): Effect.Effect<string, unknown, HttpClient.HttpClient> => {
      const credentialsEffect = Effect.tryPromise({
        try: () => {
          const options = params.account.profile === "default" ? {} : { profile: params.account.profile }
          return fromNodeProviderChain(options)()
        },
        catch: (e) => new Error(e instanceof Error ? e.message : String(e))
      }).pipe(
        Effect.map(Credentials.fromAwsCredentialIdentity),
        Effect.mapError((e) => new Error(`Auth failed for ${params.account.profile}: ${e.message}`)),
        Effect.timeout("5 seconds")
      )

      return codecommit.createPullRequest({
        title: params.title,
        ...(params.description && { description: params.description }),
        targets: [{
          repositoryName: params.repositoryName,
          sourceReference: params.sourceReference,
          destinationReference: params.destinationReference
        }]
      }).pipe(
        Effect.map((resp) => resp.pullRequest?.pullRequestId ?? ""),
        Effect.provideService(Region.Region, params.account.region as any),
        Effect.provideServiceEffect(Credentials.Credentials, credentialsEffect),
        Effect.timeout("30 seconds")
      )
    }

    const listBranches = (params: {
      account: { profile: string; region: string }
      repositoryName: string
    }): Effect.Effect<string[], unknown, HttpClient.HttpClient> => {
      const credentialsEffect = Effect.tryPromise({
        try: () => {
          const options = params.account.profile === "default" ? {} : { profile: params.account.profile }
          return fromNodeProviderChain(options)()
        },
        catch: (e) => new Error(e instanceof Error ? e.message : String(e))
      }).pipe(
        Effect.map(Credentials.fromAwsCredentialIdentity),
        Effect.mapError((e) => new Error(`Auth failed for ${params.account.profile}: ${e.message}`)),
        Effect.timeout("5 seconds")
      )

      // Paginate through all branches
      const fetchPage = (nextToken?: string): Effect.Effect<string[], unknown, HttpClient.HttpClient> =>
        codecommit.listBranches({
          repositoryName: params.repositoryName,
          ...(nextToken && { nextToken })
        }).pipe(
          Effect.flatMap((resp) => {
            const branches = resp.branches ?? []
            if (resp.nextToken) {
              return fetchPage(resp.nextToken).pipe(
                Effect.map((more) => [...branches, ...more])
              )
            }
            return Effect.succeed(branches)
          }),
          Effect.provideService(Region.Region, params.account.region as any),
          Effect.provideServiceEffect(Credentials.Credentials, credentialsEffect)
        )

      return fetchPage().pipe(
        withThrottleRetry,
        Effect.timeout("30 seconds")
      )
    }

    const getCommentsForPullRequest = (params: {
      account: { profile: string; region: string }
      pullRequestId: string
      repositoryName: string
    }): Effect.Effect<PRCommentLocation[], unknown, HttpClient.HttpClient> => {
      const credentialsEffect = Effect.tryPromise({
        try: () => {
          const options = params.account.profile === "default" ? {} : { profile: params.account.profile }
          return fromNodeProviderChain(options)()
        },
        catch: (e) => new Error(e instanceof Error ? e.message : String(e))
      }).pipe(
        Effect.map(Credentials.fromAwsCredentialIdentity),
        Effect.mapError((e) => new Error(`Auth failed for ${params.account.profile}: ${e.message}`)),
        Effect.timeout("5 seconds")
      )

      const buildThreads = (comments: PRComment[]): CommentThread[] => {
        const rootComments = comments.filter((c) => !c.inReplyTo)
        const repliesTo = (id: string): CommentThread[] =>
          comments
            .filter((c) => c.inReplyTo === id)
            .sort((a, b) => a.creationDate.getTime() - b.creationDate.getTime())
            .map((c) => ({ root: c, replies: repliesTo(c.id) }))

        return rootComments
          .sort((a, b) => a.creationDate.getTime() - b.creationDate.getTime())
          .map((c) => ({ root: c, replies: repliesTo(c.id) }))
      }

      const fetchPage = (nextToken?: string): Effect.Effect<PRCommentLocation[], unknown, HttpClient.HttpClient> =>
        codecommit.getCommentsForPullRequest({
          pullRequestId: params.pullRequestId,
          repositoryName: params.repositoryName,
          ...(nextToken && { nextToken })
        }).pipe(
          Effect.flatMap((resp) => {
            const locations = (resp.commentsForPullRequestData ?? []).map((data) => {
              const comments: PRComment[] = (data.comments ?? []).map((c) => ({
                id: c.commentId ?? "",
                content: c.content ?? "",
                author: c.authorArn ? normalizeAuthor(c.authorArn) : "unknown",
                creationDate: c.creationDate ?? new Date(),
                inReplyTo: c.inReplyTo,
                deleted: c.deleted ?? false,
                filePath: data.location?.filePath,
                lineNumber: data.location?.filePosition
              }))

              return {
                filePath: data.location?.filePath,
                beforeCommitId: data.beforeCommitId,
                afterCommitId: data.afterCommitId,
                comments: buildThreads(comments)
              } as PRCommentLocation
            })

            if (resp.nextToken) {
              return fetchPage(resp.nextToken).pipe(
                Effect.map((more) => [...locations, ...more])
              )
            }
            return Effect.succeed(locations)
          }),
          Effect.provideService(Region.Region, params.account.region as any),
          Effect.provideServiceEffect(Credentials.Credentials, credentialsEffect)
        )

      return fetchPage().pipe(
        withThrottleRetry,
        Effect.timeout("60 seconds")
      )
    }

    const updatePullRequestTitle = (params: {
      account: { profile: string; region: string }
      pullRequestId: string
      title: string
    }): Effect.Effect<void, unknown, HttpClient.HttpClient> => {
      const credentialsEffect = Effect.tryPromise({
        try: () => {
          const options = params.account.profile === "default" ? {} : { profile: params.account.profile }
          return fromNodeProviderChain(options)()
        },
        catch: (e) => new Error(e instanceof Error ? e.message : String(e))
      }).pipe(
        Effect.map(Credentials.fromAwsCredentialIdentity),
        Effect.mapError((e) => new Error(`Auth failed for ${params.account.profile}: ${e.message}`)),
        Effect.timeout("5 seconds")
      )

      return codecommit.updatePullRequestTitle({
        pullRequestId: params.pullRequestId,
        title: params.title
      }).pipe(
        Effect.asVoid,
        Effect.provideService(Region.Region, params.account.region as any),
        Effect.provideServiceEffect(Credentials.Credentials, credentialsEffect),
        Effect.timeout("30 seconds")
      )
    }

    const updatePullRequestDescription = (params: {
      account: { profile: string; region: string }
      pullRequestId: string
      description: string
    }): Effect.Effect<void, unknown, HttpClient.HttpClient> => {
      const credentialsEffect = Effect.tryPromise({
        try: () => {
          const options = params.account.profile === "default" ? {} : { profile: params.account.profile }
          return fromNodeProviderChain(options)()
        },
        catch: (e) => new Error(e instanceof Error ? e.message : String(e))
      }).pipe(
        Effect.map(Credentials.fromAwsCredentialIdentity),
        Effect.mapError((e) => new Error(`Auth failed for ${params.account.profile}: ${e.message}`)),
        Effect.timeout("5 seconds")
      )

      return codecommit.updatePullRequestDescription({
        pullRequestId: params.pullRequestId,
        description: params.description
      }).pipe(
        Effect.asVoid,
        Effect.provideService(Region.Region, params.account.region as any),
        Effect.provideServiceEffect(Credentials.Credentials, credentialsEffect),
        Effect.timeout("30 seconds")
      )
    }

    const getPullRequest = (params: {
      account: { profile: string; region: string }
      pullRequestId: string
    }): Effect.Effect<{
      title: string
      description?: string
      author: string
      status: string
      repositoryName: string
      sourceBranch: string
      destinationBranch: string
      creationDate: Date
    }, unknown, HttpClient.HttpClient> => {
      const credentialsEffect = Effect.tryPromise({
        try: () => {
          const options = params.account.profile === "default" ? {} : { profile: params.account.profile }
          return fromNodeProviderChain(options)()
        },
        catch: (e) => new Error(e instanceof Error ? e.message : String(e))
      }).pipe(
        Effect.map(Credentials.fromAwsCredentialIdentity),
        Effect.mapError((e) => new Error(`Auth failed for ${params.account.profile}: ${e.message}`)),
        Effect.timeout("5 seconds")
      )

      return codecommit.getPullRequest({ pullRequestId: params.pullRequestId }).pipe(
        Effect.map((resp) => {
          const pr = resp.pullRequest!
          const target = pr.pullRequestTargets?.[0]
          return {
            title: pr.title ?? "",
            ...(pr.description && { description: pr.description }),
            author: pr.authorArn ? normalizeAuthor(pr.authorArn) : "unknown",
            status: pr.pullRequestStatus ?? "UNKNOWN",
            repositoryName: target?.repositoryName ?? "",
            sourceBranch: target?.sourceReference ?? "",
            destinationBranch: target?.destinationReference ?? "",
            creationDate: pr.creationDate ?? new Date()
          }
        }),
        Effect.provideService(Region.Region, params.account.region as any),
        Effect.provideServiceEffect(Credentials.Credentials, credentialsEffect),
        Effect.timeout("30 seconds")
      )
    }

    return { getPullRequests, getCallerIdentity, createPullRequest, listBranches, getCommentsForPullRequest, updatePullRequestTitle, updatePullRequestDescription, getPullRequest }
  })
)

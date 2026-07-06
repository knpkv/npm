/**
 * @internal
 */
import type { Credentials, Region } from "distilled-aws"
import type { ListBranchesError } from "distilled-aws/codecommit"
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Option, Stream } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { type ListBranchesParams, makeApiError, withAwsContext } from "./internal.js"

type BranchPageError = ListBranchesError
type BranchPageEnv = Credentials.Credentials | Region.Region | HttpClient.HttpClient

const firstPageToken: string | undefined = undefined

const nextPageToken = (token: string | undefined): Option.Option<string | undefined> =>
  token === undefined ? Option.none() : Option.some(token)

const branchPage = (
  branches: ReadonlyArray<string>,
  nextToken: Option.Option<string | undefined>
): readonly [ReadonlyArray<string>, Option.Option<string | undefined>] => [branches, nextToken]

const branchPageRequest = (repositoryName: string, nextToken: string | undefined) =>
  nextToken === undefined ? { repositoryName } : { repositoryName, nextToken }

const fetchBranchPages = (repositoryName: string) =>
  Stream.paginate<string | undefined, string, BranchPageError, BranchPageEnv>(
    firstPageToken,
    (nextToken) =>
      codecommit.listBranches(branchPageRequest(repositoryName, nextToken)).pipe(
        Effect.map((resp) =>
          branchPage(
            resp.branches ?? [],
            nextPageToken(resp.nextToken)
          )
        )
      )
  ).pipe(
    Stream.flatMap(Stream.fromIterable)
  )

export const listBranches = (params: ListBranchesParams) =>
  withAwsContext(
    "listBranches",
    params.account,
    fetchBranchPages(params.repositoryName).pipe(
      Stream.mapError((cause) => makeApiError("listBranches", params.account.profile, params.account.region, cause)),
      Stream.runCollect
    )
  ).pipe(Effect.map((chunk) => Array.from(chunk)))

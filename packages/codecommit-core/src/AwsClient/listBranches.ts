/**
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Option, Stream } from "effect"
import { type ListBranchesParams, makeApiError, withAwsContext } from "./internal.js"

const fetchBranchPages = (repositoryName: string) =>
  Stream.paginateEffect(
    undefined as string | undefined,
    (nextToken) =>
      codecommit.listBranches({
        repositoryName,
        ...(nextToken && { nextToken })
      }).pipe(
        Effect.map((resp) =>
          [
            resp.branches ?? [],
            resp.nextToken ? Option.some(resp.nextToken) : Option.none()
          ] as const
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

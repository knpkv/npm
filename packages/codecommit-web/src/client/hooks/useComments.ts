import { useAtomValue } from "@effect/atom-react"
import type { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { useMemo } from "react"
import { ApiClient } from "../atoms/runtime.js"

export function useComments(params: {
  pullRequestId: string
  repositoryName: string
  profile: AwsProfileName
  region: AwsRegion
  refreshGeneration?: number
}) {
  const refreshGeneration = params.refreshGeneration ?? 0
  const query = {
    pullRequestId: params.pullRequestId,
    repositoryName: params.repositoryName,
    profile: params.profile,
    region: params.region
  }
  const queryAtom = useMemo(
    () =>
      ApiClient.query("prs", "comments", {
        query,
        serializationKey: `${params.profile}:${params.region}:${params.repositoryName}:${params.pullRequestId}:${
          String(refreshGeneration)
        }`,
        timeToLive: "60 seconds"
      }),
    [params.pullRequestId, params.repositoryName, params.profile, params.region, refreshGeneration]
  )
  return useAtomValue(queryAtom)
}

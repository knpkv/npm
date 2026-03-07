import { useAtomValue } from "@effect-atom/atom-react"
import type { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { useMemo } from "react"
import { ApiClient } from "../atoms/runtime.js"

export function useComments(params: {
  pullRequestId: string
  repositoryName: string
  profile: AwsProfileName
  region: AwsRegion
}) {
  const queryAtom = useMemo(
    () =>
      ApiClient.query("prs", "comments", {
        urlParams: params,
        timeToLive: "60 seconds"
      }),
    [params.pullRequestId, params.repositoryName, params.profile, params.region]
  )
  return useAtomValue(queryAtom)
}

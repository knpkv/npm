import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { useComments } from "../hooks/useComments.js"
import { PRLifecycleView } from "./pr-lifecycle-view.js"

export function LifecycleInfo({ pr }: { readonly pr: Domain.PullRequest }) {
  const commentsResult = useComments({
    pullRequestId: pr.id,
    repositoryName: pr.repositoryName,
    profile: pr.account.profile,
    region: pr.account.region
  })

  return <PRLifecycleView comments={commentsResult} pr={pr} />
}

import { useComments } from "../hooks/useComments.js"
import type { PRCommentsSlotInput } from "./pr-detail-view.js"
import { PRCommentsView } from "./pr-comments-view.js"

export function CommentsSection({
  navigation,
  onCountChange,
  onNavigateToDiff,
  pullRequest: pr,
  refreshGeneration: commentsRefreshGeneration,
  visible
}: PRCommentsSlotInput) {
  const commentsResult = useComments({
    pullRequestId: pr.id,
    repositoryName: pr.repositoryName,
    profile: pr.account.profile,
    region: pr.account.region,
    refreshGeneration: commentsRefreshGeneration
  })

  return (
    <PRCommentsView
      comments={commentsResult}
      navigation={navigation}
      now={new Date()}
      onCountChange={onCountChange}
      onNavigateToDiff={onNavigateToDiff}
      visible={visible}
    />
  )
}

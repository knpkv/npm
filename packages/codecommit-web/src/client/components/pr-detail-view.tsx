import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import type { HealthScore } from "@knpkv/codecommit-core/HealthScore.js"
import { Button as RlyButton, StatePanel } from "@knpkv/rly/primitives"
import { Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { Fragment, Suspense, type ReactNode } from "react"
import type { ReviewCommentNavigation, ReviewCommentNavigationTarget } from "../review-comment-navigation.js"
import { PRApprovalsView, type RuleRemoval } from "./pr-approvals-view.js"
import type { PRCommentsResult } from "./pr-comments-view.js"
import { CollapsibleSection } from "./pr-detail-disclosure.js"
import { PRDetailHeaderView } from "./pr-detail-header-view.js"
import type { PullRequestLoadFailure } from "./pr-detail-presentation.js"
import { PRDescriptionView } from "./pr-description-view.js"
import { PRRevisionView } from "./pr-revision-view.js"
import { PRHealthBreakdownView } from "./pr-health-breakdown-view.js"
import { PRRequirementDialogsView } from "./pr-requirement-dialogs-view.js"
import styles from "./pr-detail.module.css"

export type { PullRequestLoadFailure } from "./pr-detail-presentation.js"

export interface PRHealthPresentation {
  readonly score: HealthScore | undefined
  readonly unknownReason: Option.Option<string>
}

export interface PRDetailActions {
  readonly isRefreshing: boolean
  readonly isSubscribed: boolean
  readonly sandboxState: "create" | "open" | "stopping"
  readonly copied: boolean
  readonly onBack: () => void
  readonly onRefresh: () => void
  readonly onSubscriptionToggle: () => void
  readonly onSandbox: () => void
  readonly onCopyLink: () => void
  readonly onOpenConsole: () => void
  readonly onRetryLoad: () => void
  readonly onOpenAccountsSettings: () => void
}

export interface CommentCountSnapshot {
  readonly commentIds: ReadonlyArray<string>
  readonly count: number
}

export interface PRDetailComments {
  readonly count: number | undefined
  readonly navigation: ReviewCommentNavigation | null
  readonly refreshGeneration: number
  readonly onCountChange: (snapshot: CommentCountSnapshot) => void
  readonly onNavigateToDiff: (target: ReviewCommentNavigationTarget) => void
}

export interface PRCommentsSlotInput {
  readonly pullRequest: Domain.PullRequest
  readonly navigation: ReviewCommentNavigation | null
  readonly refreshGeneration: number
  readonly visible: boolean
  readonly now: Date
  readonly onCountChange: (snapshot: CommentCountSnapshot) => void
  readonly onNavigateToDiff: (target: ReviewCommentNavigationTarget) => void
}

export interface PRReviewWorkspaceSlotInput {
  readonly accountId: string
  readonly pullRequest: Domain.PullRequest
  readonly refreshGeneration: number
  readonly commentsRefreshGeneration: number
  readonly commentNavigation: ReviewCommentNavigation | null
  readonly onFindingPosted: (operationId: string) => void
  readonly onNavigateToComment: (target: ReviewCommentNavigationTarget) => void
}

export interface PRRequirementDialogState {
  readonly visible: boolean
  readonly dontRemind: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onDontRemindChange: (checked: boolean) => void
  readonly onCancel: () => void
  readonly onContinue: () => void
}

export interface PRRequirementDialogsViewProps {
  readonly granted: PRRequirementDialogState
  readonly docker: PRRequirementDialogState
}

export type PRApproverKind = "required" | "optional"

export interface PRApprovalActions {
  readonly currentUser: string | undefined
  readonly knownUserArns: ReadonlyMap<string, string>
  readonly repoAccountId: string
  readonly permissionPrompt: boolean
  readonly onSetApprovers: (kind: PRApproverKind, identities: ReadonlyArray<string>) => void
  readonly onRemoveRule: (kind: PRApproverKind) => Promise<RuleRemoval>
  readonly onRefresh: () => Promise<boolean>
}

export interface PRDetailViewProps {
  readonly pullRequest: AsyncResult.AsyncResult<Domain.PullRequest, PullRequestLoadFailure>
  readonly routeAmbiguous: boolean
  readonly now: Date
  readonly health: PRHealthPresentation
  readonly actions: PRDetailActions
  readonly approvals: PRApprovalActions
  readonly comments: PRDetailComments
  readonly dialogs: PRRequirementDialogsViewProps
  readonly review: Omit<PRReviewWorkspaceSlotInput, "pullRequest">
  readonly renderReviewWorkspace: (input: PRReviewWorkspaceSlotInput) => ReactNode
  readonly renderComments: (input: PRCommentsSlotInput) => ReactNode
  readonly renderLifecycle: (pr: Domain.PullRequest) => ReactNode
}

export interface PRDetailHeaderViewProps {
  readonly pr: Domain.PullRequest
  readonly now: Date
  readonly actions: PRDetailActions
}

export interface PRRevisionViewProps {
  readonly pr: Domain.PullRequest
  readonly health: PRHealthPresentation
  readonly renderLifecycle: (pr: Domain.PullRequest) => ReactNode
}

export interface PRDescriptionViewProps {
  readonly description: string
}

export interface PRCommentsViewProps {
  readonly comments: PRCommentsResult
  readonly navigation: ReviewCommentNavigation | null
  readonly visible: boolean
  readonly now: Date
  readonly onCountChange: (snapshot: CommentCountSnapshot) => void
  readonly onNavigateToDiff: (target: ReviewCommentNavigationTarget) => void
}

export interface PRLifecycleViewProps {
  readonly pr: Domain.PullRequest
  readonly comments: PRCommentsResult
}

export interface PRApprovalsViewProps {
  readonly pr: Domain.PullRequest
  readonly actions: PRApprovalActions
}

export function PRDetailView({
  actions,
  approvals,
  comments,
  dialogs,
  health,
  now,
  pullRequest,
  renderComments,
  renderLifecycle,
  renderReviewWorkspace,
  review,
  routeAmbiguous
}: PRDetailViewProps) {
  const pr = AsyncResult.isSuccess(pullRequest) ? pullRequest.value : null
  const loadFailure = AsyncResult.isFailure(pullRequest) ? Option.getOrNull(AsyncResult.error(pullRequest)) : null
  if (routeAmbiguous) {
    return (
      <section className={styles.loadingState}>
        <StatePanel
          announce="assertive"
          description="Choose both repository and region to identify this pull request."
          title="Pull request coordinates are ambiguous"
          tone="critical"
        />
      </section>
    )
  }

  if (pr === null && loadFailure !== null) {
    return (
      <section className={styles.loadingState}>
        <StatePanel
          action={
            <>
              {loadFailure.fixInSettings ? (
                <RlyButton onClick={actions.onOpenAccountsSettings} size="compact" variant="primary">
                  Open Settings → Accounts
                </RlyButton>
              ) : null}
              <RlyButton onClick={actions.onRetryLoad} size="compact">
                Try again
              </RlyButton>
            </>
          }
          announce="assertive"
          description={loadFailure.message}
          title="Can't read this pull request"
          tone="critical"
        />
      </section>
    )
  }

  if (pr === null) {
    return (
      <section className={styles.loadingState}>
        <StatePanel
          announce="polite"
          description="Reading the current provider facts and approval state from CodeCommit."
          title="Loading pull request"
          tone="progress"
        />
      </section>
    )
  }

  return (
    <article className={styles.page}>
      <PRDetailHeaderView pr={pr} now={now} actions={actions} />
      <PRRevisionView pr={pr} health={health} renderLifecycle={renderLifecycle} />
      <Suspense
        fallback={
          <StatePanel
            announce="polite"
            description="Preparing the exact-revision review workbench."
            title="Loading diff tools"
            tone="progress"
          />
        }
      >
        {renderReviewWorkspace({ ...review, pullRequest: pr })}
      </Suspense>

      <div className={styles.reviewWorkspace}>
        <section aria-label="Pull request narrative and comments" className={styles.contentColumn}>
          {pr.description !== undefined && pr.description.length > 0 ? (
            <PRDescriptionView description={pr.description} />
          ) : null}

          <CollapsibleSection
            {...(comments.navigation?.destination === "comment"
              ? { openRequestKey: `${comments.navigation.target.commentId}:${String(comments.navigation.requestId)}` }
              : {})}
            keepMounted
            title="Comments"
            {...(comments.count !== undefined ? { count: comments.count } : {})}
          >
            {(commentsVisible) => (
              <Fragment key={pr.id}>
                {renderComments({
                  pullRequest: pr,
                  refreshGeneration: comments.refreshGeneration,
                  navigation: comments.navigation,
                  onCountChange: comments.onCountChange,
                  onNavigateToDiff: comments.onNavigateToDiff,
                  visible: commentsVisible,
                  now
                })}
              </Fragment>
            )}
          </CollapsibleSection>
        </section>

        <aside className={styles.evidenceColumn}>
          <PRApprovalsView pr={pr} actions={approvals} />
          <CollapsibleSection title="Health Score Breakdown">
            {() => <PRHealthBreakdownView health={health} />}
          </CollapsibleSection>
        </aside>
      </div>
      <PRRequirementDialogsView {...dialogs} />
    </article>
  )
}

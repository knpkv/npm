/** PR detail controller: owns route lookup, mutations, shortcuts, reminders and refresh timers. */
import { PullRequestCommitSummaries } from "../commit-summaries.js"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AwsRegion, currentApprovers, PullRequestId } from "@knpkv/codecommit-core/Domain.js"
import { calculateHealthScore, type HealthScore, healthUnknownReason } from "@knpkv/codecommit-core/HealthScore.js"
import { Exit, Option } from "effect"
import * as Cause from "effect/Cause"
import * as Predicate from "effect/Predicate"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import { toast } from "sonner"
import {
  appStateAtom,
  createApprovalRuleAtom,
  deleteApprovalRuleAtom,
  createSandboxAtom,
  openPrAtom,
  refreshSinglePrAtom,
  subscribeAtom,
  subscriptionsQueryAtom,
  unsubscribeAtom,
  updateApprovalRuleAtom
} from "../atoms/app.js"
import { useDismissable } from "../hooks/useDismissable.js"
import { useOptimistic } from "../hooks/useOptimistic.js"
import { pullRequestRouteCoordinates } from "../codecommit-route.js"
import type { ReviewCommentNavigation, ReviewCommentNavigationTarget } from "../review-comment-navigation.js"
import { StorageKeys } from "../storage-keys.js"
import { makeInFlight, pullRequestRefreshKey } from "../utils/inFlight.js"
import { PRDetailView, type CommentCountSnapshot } from "./pr-detail-view.js"
import { CommentsSection } from "./pr-comments.js"
import { LifecycleInfo } from "./pr-lifecycle.js"
import { REQUIRED_RULE_NAME, OPTIONAL_RULE_NAME, type RuleRemoval } from "./pr-approvals-view.js"
import {
  sandboxAccountIdForPullRequest,
  isReusableSandbox,
  isStoppingSandbox,
  hasFallbackSandboxCollision,
  reviewApiAccountId,
  commentNavigationIdentityForCoordinates,
  selectCodeCommitPullRequest,
  isTextInputTarget,
  focusedElement,
  ownsEnterKey,
  insideOpenDialog
} from "./pr-detail-helpers.js"
import {
  pullRequestLoadFailure,
  refreshFailureDescription,
  type PullRequestLoadFailure
} from "./pr-detail-presentation.js"

const PullRequestReviewWorkspace = lazy(() =>
  import("./pr-review-workspace.js").then((module) => ({
    default: module.PullRequestReviewWorkspace
  }))
)

interface OptimisticCommentCount {
  readonly baseCount: number
  readonly count: number
  readonly identity: string
  readonly pendingCommentIds: ReadonlyArray<string>
}

export function PRDetail() {
  const { accountId, prId } = useParams<{ accountId: string; prId: string }>()
  const [searchParams] = useSearchParams()
  const state = useAtomValue(appStateAtom)
  // The pull request as the route names it: these never change while the page shows it, unlike the
  // account id and coordinates the loaded PR supplies later.
  const refreshKey = pullRequestRefreshKey(
    accountId,
    prId ?? "",
    searchParams.get("repository") ?? undefined,
    searchParams.get("region") ?? undefined
  )
  const refreshSingleWithResult = useAtomSet(refreshSinglePrAtom(refreshKey), { mode: "promise" })
  // One refresh per pull request at a time: overlapping triggers share it instead of cancelling it.
  // Scoped to the route: leaving a pull request releases its refresh atom, which can interrupt a
  // pending call whose promise then never settles, so a later visit starts from a fresh map rather
  // than wait on it.
  const shareRefresh = useMemo(() => makeInFlight<Awaited<ReturnType<typeof refreshSingleWithResult>>>(), [refreshKey])
  const createRule = useAtomSet(createApprovalRuleAtom)
  const updateRule = useAtomSet(updateApprovalRuleAtom)
  const deleteRule = useAtomSet(deleteApprovalRuleAtom, { mode: "promiseExit" })
  const fetchedRef = useRef<string | null>(null)
  const [loadFailure, setLoadFailure] = useState<PullRequestLoadFailure | null>(null)
  const routeSelection = useMemo(() => {
    const route = pullRequestRouteCoordinates(accountId, prId, searchParams)
    return route === undefined
      ? { pullRequest: null, ambiguous: false }
      : selectCodeCommitPullRequest(state.pullRequests, route)
  }, [accountId, prId, searchParams, state.pullRequests])
  const pr = routeSelection.pullRequest
  const routeHasPartialCoordinates = searchParams.has("repository") !== searchParams.has("region")
  const routeAmbiguous = routeHasPartialCoordinates || routeSelection.ambiguous
  const refreshAccountId = pr === null ? accountId : reviewApiAccountId(pr)
  const refreshRepositoryName = pr === null ? (searchParams.get("repository") ?? undefined) : String(pr.repositoryName)
  const refreshRegion = pr === null ? (searchParams.get("region") ?? undefined) : String(pr.account.region)
  // Keyed by the route, so the mount refresh and a later click share one request even after the
  // loaded PR replaces the account id and coordinates the request uses. `fresh` waits for a pending
  // request (it may have read the state before a change) and then reads again.
  const requestRefresh = useCallback(
    (requestAccountId: string, id: string, policy: "share" | "fresh" = "share") =>
      shareRefresh[policy](refreshKey, () =>
        refreshSingleWithResult({
          params: { awsAccountId: requestAccountId, prId: PullRequestId.make(id) },
          query:
            refreshRepositoryName !== undefined && refreshRegion !== undefined
              ? { repositoryName: refreshRepositoryName, region: AwsRegion.make(refreshRegion) }
              : {}
        })
      ),
    [refreshKey, refreshRegion, refreshRepositoryName, refreshSingleWithResult, shareRefresh]
  )

  // Collect ALL known users from all PRs (authors, approvers, commenters, pool members)
  // Build CodeCommitApprovers:REPO_ACCT:username directly — no ARN needed
  const currentAcct = pr?.account?.repoAccountId || ""
  const knownUserArns = useMemo(() => {
    const map = new Map<string, string>()
    // All users stamped with currentAcct — approval pools reference the PR's repo account.
    // If same username exists across accounts, first-seen wins (acceptable for single-org use).
    const addUser = (name: string) => {
      if (name.length === 0 || name === "*") return
      if (!map.has(name)) {
        map.set(name, currentAcct.length > 0 ? `CodeCommitApprovers:${currentAcct}:${name}` : name)
      }
    }
    for (const p of state.pullRequests) {
      addUser(p.author)
      for (const name of currentApprovers(p)) addUser(name)
      for (const name of p.commentedBy) addUser(name)
      for (const rule of p.approvalRules) {
        for (const name of rule.poolMembers) addUser(name)
      }
    }
    return map
  }, [state.pullRequests, currentAcct])

  // Fetch from AWS when PR not in cache (e.g. merged/closed)
  useEffect(() => {
    if (
      routeAmbiguous ||
      pr !== null ||
      refreshAccountId === undefined ||
      refreshAccountId.length === 0 ||
      prId === undefined ||
      prId.length === 0
    )
      return
    const key = `${refreshAccountId}:${prId}:${refreshRepositoryName ?? ""}:${refreshRegion ?? ""}`
    if (fetchedRef.current === key) return
    fetchedRef.current = key
    setLoadFailure(null)
    // A failed first read replaces the loading panel with its reason; it must never spin on.
    void requestRefresh(refreshAccountId, prId).then(
      () => setLoadFailure(null),
      (cause: unknown) => setLoadFailure(pullRequestLoadFailure(cause))
    )
  }, [pr, prId, refreshAccountId, refreshRegion, refreshRepositoryName, requestRefresh, routeAmbiguous])

  const retryLoad = useCallback(() => {
    if (refreshAccountId === undefined || refreshAccountId.length === 0 || prId === undefined || prId.length === 0) {
      return
    }
    setLoadFailure(null)
    void requestRefresh(refreshAccountId, prId, "fresh").then(
      () => setLoadFailure(null),
      (cause: unknown) => setLoadFailure(pullRequestLoadFailure(cause))
    )
  }, [prId, refreshAccountId, requestRefresh])

  const score: HealthScore | undefined = useMemo(
    () => (pr !== null ? Option.getOrUndefined(calculateHealthScore(pr, new Date())) : undefined),
    [pr]
  )
  const scoreUnknownReason = useMemo(() => (pr !== null ? healthUnknownReason(pr) : Option.none<string>()), [pr])
  const navigate = useNavigate()
  const openPr = useAtomSet(openPrAtom)
  const granted = useDismissable(StorageKeys.grantedDismissed)
  const docker = useDismissable(StorageKeys.dockerDismissed)

  // Subscriptions
  const subscriptionsResult = useAtomValue(subscriptionsQueryAtom)
  const subscribe = useAtomSet(subscribeAtom)
  const unsubscribe = useAtomSet(unsubscribeAtom)
  const accountKey = pr?.account.awsAccountId ?? pr?.account.profile
  const subscriptionCoordinates =
    pr === null ? undefined : { repositoryName: String(pr.repositoryName), region: pr.account.region }
  const serverSubscribed = useMemo(
    () =>
      AsyncResult.isSuccess(subscriptionsResult) && accountKey !== undefined && accountKey.length > 0
        ? subscriptionsResult.value.some(
            (s) =>
              s.awsAccountId === accountKey &&
              s.pullRequestId === prId &&
              s.repositoryName === subscriptionCoordinates?.repositoryName &&
              s.accountRegion === subscriptionCoordinates?.region
          )
        : false,
    [subscriptionsResult, accountKey, prId, subscriptionCoordinates]
  )
  const [isSubscribed, setOptimistic] = useOptimistic(serverSubscribed)
  const handleSubscriptionToggle = useCallback(() => {
    if (accountKey === undefined || accountKey.length === 0 || pr === null) return
    const payload = {
      awsAccountId: accountKey,
      pullRequestId: pr.id,
      repositoryName: String(pr.repositoryName),
      region: pr.account.region
    }
    setOptimistic(!isSubscribed)
    if (isSubscribed) {
      unsubscribe({ payload })
    } else {
      subscribe({ payload })
    }
  }, [accountKey, isSubscribed, pr, subscribe, unsubscribe])

  // Refresh single PR
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [reviewRefreshGeneration, setReviewRefreshGeneration] = useState(0)
  const [commentsRefreshGeneration, setCommentsRefreshGeneration] = useState(0)
  const commentRefreshTimersRef = useRef<Set<number>>(new Set())
  const commentNavigationIdentity = commentNavigationIdentityForCoordinates(
    accountKey ?? accountId,
    prId,
    pr === null ? refreshRepositoryName : String(pr.repositoryName),
    pr === null ? refreshRegion : String(pr.account.region)
  )
  const [commentCountState, setCommentCountState] = useState<OptimisticCommentCount | null>(null)
  const authoritativeCommentCount = pr?.commentCount
  const commentCount = (() => {
    if (authoritativeCommentCount === undefined || commentCountState?.identity !== commentNavigationIdentity) {
      return authoritativeCommentCount
    }
    return Math.max(authoritativeCommentCount, commentCountState.count)
  })()
  const [commentNavigationState, setCommentNavigationState] = useState<{
    readonly identity: string
    readonly navigation: ReviewCommentNavigation
  } | null>(null)
  const commentNavigation =
    commentNavigationState?.identity === commentNavigationIdentity ? commentNavigationState.navigation : null
  const commentNavigationRequestRef = useRef(0)
  const requestCommentNavigation = useCallback(
    (destination: ReviewCommentNavigation["destination"], target: ReviewCommentNavigationTarget) => {
      commentNavigationRequestRef.current += 1
      setCommentNavigationState({
        identity: commentNavigationIdentity,
        navigation: { destination, requestId: commentNavigationRequestRef.current, target }
      })
    },
    [commentNavigationIdentity]
  )
  const reviewedRevisionRef = useRef<string | null>(null)
  const invalidateReview = useCallback(
    (refreshed: { readonly revisionId: string; readonly headCommit: string }, force: boolean) => {
      const revision = `${accountKey ?? ""}:${prId ?? ""}:${refreshed.revisionId}:${refreshed.headCommit}`
      const changed = reviewedRevisionRef.current !== revision
      reviewedRevisionRef.current = revision
      if (force || changed) {
        setReviewRefreshGeneration((current) => current + 1)
      }
    },
    [accountKey, prId]
  )
  useEffect(
    () => () => {
      for (const timer of commentRefreshTimersRef.current) window.clearTimeout(timer)
      commentRefreshTimersRef.current.clear()
    },
    []
  )
  useEffect(() => {
    if (authoritativeCommentCount === undefined) return
    setCommentCountState((current) => {
      if (current?.identity !== commentNavigationIdentity || authoritativeCommentCount === current.baseCount)
        return current
      if (current.pendingCommentIds.length > 0) {
        return {
          ...current,
          baseCount: authoritativeCommentCount,
          count: Math.max(current.count, authoritativeCommentCount)
        }
      }
      return authoritativeCommentCount < current.count ? { ...current, baseCount: authoritativeCommentCount } : null
    })
  }, [authoritativeCommentCount, commentNavigationIdentity])
  const reconcileCommentCount = useCallback(
    (snapshot: CommentCountSnapshot) => {
      const baseCount = pr?.commentCount ?? 0
      setCommentCountState((current) => {
        if (current?.identity !== commentNavigationIdentity) return current
        const observedCommentIds = new Set(snapshot.commentIds)
        const pendingCommentIds = current.pendingCommentIds.filter((commentId) => !observedCommentIds.has(commentId))
        const count = snapshot.count + pendingCommentIds.length
        return pendingCommentIds.length === 0 && count <= baseCount
          ? null
          : { ...current, baseCount, count: Math.max(baseCount, count), pendingCommentIds }
      })
    },
    [commentNavigationIdentity, pr?.commentCount]
  )
  const refreshCommentsAfterPublication = useCallback(
    (operationId: string) => {
      const commentId = operationId.startsWith("comment:") ? operationId.slice("comment:".length) : operationId
      setCommentCountState((current) => {
        const baseCount = pr?.commentCount ?? 0
        return current?.identity === commentNavigationIdentity
          ? {
              ...current,
              baseCount,
              count: Math.max(current.count, baseCount) + 1,
              pendingCommentIds: [...current.pendingCommentIds, commentId]
            }
          : {
              baseCount,
              count: baseCount + 1,
              identity: commentNavigationIdentity,
              pendingCommentIds: [commentId]
            }
      })
      setCommentsRefreshGeneration((current) => current + 1)
      for (const delay of [1_500, 5_000]) {
        const timer = window.setTimeout(() => {
          commentRefreshTimersRef.current.delete(timer)
          setCommentsRefreshGeneration((current) => current + 1)
        }, delay)
        commentRefreshTimersRef.current.add(timer)
      }
    },
    [commentNavigationIdentity, pr?.commentCount]
  )
  /** Re-reads this pull request after an approval change; resolves with whether the refresh succeeded. */
  const refreshAfterApprovalMutation = useCallback((): Promise<boolean> => {
    if (refreshAccountId === undefined || refreshAccountId.length === 0 || prId === undefined || prId.length === 0)
      return Promise.resolve(false)
    // A refresh already in flight may have read the rules before this change, so read again after it.
    return requestRefresh(refreshAccountId, prId, "fresh").then(
      (refreshed) => {
        invalidateReview(refreshed, false)
        return true
      },
      () => false
    )
  }, [invalidateReview, prId, refreshAccountId, requestRefresh])
  const handleRefresh = useCallback(() => {
    if (
      refreshAccountId === undefined ||
      refreshAccountId.length === 0 ||
      prId === undefined ||
      prId.length === 0 ||
      isRefreshing
    )
      return
    setIsRefreshing(true)
    void requestRefresh(refreshAccountId, prId).then(
      (refreshed) => {
        invalidateReview(refreshed, true)
        setIsRefreshing(false)
      },
      (cause: unknown) => {
        setIsRefreshing(false)
        toast.error("Unable to refresh pull request", {
          description: refreshFailureDescription(cause)
        })
      }
    )
  }, [invalidateReview, isRefreshing, prId, refreshAccountId, requestRefresh])

  // Copy console URL
  const consoleUrl =
    pr !== null
      ? pr.link.length > 0
        ? pr.link
        : `https://${pr.account.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${pr.repositoryName}/pull-requests/${pr.id}?region=${pr.account.region}`
      : ""
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    if (consoleUrl.length === 0) return
    navigator.clipboard.writeText(consoleUrl).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => {
        /* clipboard denied — noop */
      }
    )
  }, [consoleUrl])

  // Sandbox
  const createSandbox = useAtomSet(createSandboxAtom, { mode: "promiseExit" })
  const existingSandbox = useMemo(
    () => (pr === null ? undefined : state.sandboxes?.find((sandbox) => isReusableSandbox(sandbox, pr))),
    [pr, state.sandboxes]
  )
  const stoppingSandbox = useMemo(
    () => (pr === null ? undefined : state.sandboxes?.find((sandbox) => isStoppingSandbox(sandbox, pr))),
    [pr, state.sandboxes]
  )
  const fallbackSandboxCollision = useMemo(
    () => (pr === null ? false : hasFallbackSandboxCollision(state.sandboxes ?? [], pr)),
    [pr, state.sandboxes]
  )

  const [sandboxCreating, setSandboxCreating] = useState(false)

  useEffect(() => {
    if (sandboxCreating && existingSandbox !== undefined) {
      setSandboxCreating(false)
      navigate(`/sandbox/${existingSandbox.id}`)
    }
  }, [sandboxCreating, existingSandbox, navigate])

  const proceedSandbox = useCallback(() => {
    if (pr === null) return
    const sandboxAccountKey = sandboxAccountIdForPullRequest(pr)
    const request = createSandbox({
      payload: {
        pullRequestId: pr.id,
        awsAccountId: sandboxAccountKey,
        repositoryName: pr.repositoryName,
        sourceBranch: pr.sourceBranch,
        profile: pr.account.profile,
        region: pr.account.region
      }
    })
    setSandboxCreating(true)
    void request.then((exit) => {
      if (Exit.isFailure(exit)) {
        setSandboxCreating(false)
        const description = Option.match(Exit.findErrorOption(exit), {
          onNone: () => "Try again once the current sandbox has stopped.",
          onSome: (error) =>
            Predicate.isError(error) ? error.message : "Try again once the current sandbox has stopped."
        })
        toast.error("Unable to create sandbox", { description })
      }
    })
  }, [pr, createSandbox])

  const handleSandbox = useCallback(() => {
    if (pr === null) return
    if (fallbackSandboxCollision) {
      toast.info("AWS account discovery is unavailable. Refresh before creating a sandbox.")
      return
    }
    if (stoppingSandbox !== undefined) {
      toast.info("Sandbox is still stopping. Try again once it has stopped.")
      return
    }
    if (existingSandbox !== undefined) {
      navigate(`/sandbox/${existingSandbox.id}`)
      return
    }
    if (!docker.show()) {
      proceedSandbox()
    }
  }, [pr, fallbackSandboxCollision, stoppingSandbox, existingSandbox, docker, proceedSandbox, navigate])

  const handleDockerContinue = () => {
    docker.dismiss()
    proceedSandbox()
  }

  const proceedOpen = useCallback(() => {
    if (pr === null || consoleUrl.length === 0) return
    openPr({ payload: { profile: pr.account.profile, link: consoleUrl } })
  }, [consoleUrl, openPr, pr])

  const handleOpen = useCallback(() => {
    if (pr === null) return
    if (!granted.show()) {
      proceedOpen()
    }
  }, [granted, pr, proceedOpen])

  const handleGrantedContinue = () => {
    granted.dismiss()
    proceedOpen()
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInputTarget(e.target) || insideOpenDialog(e.composedPath())) return
      if (e.key === "Escape") {
        e.preventDefault()
        navigate("/")
      } else if (
        (e.key === "o" || (e.key === "Enter" && !ownsEnterKey(focusedElement(e.target)))) &&
        consoleUrl.length > 0
      ) {
        handleOpen()
      } else if (e.key === "." && pr !== null) {
        e.preventDefault()
        handleSandbox()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [consoleUrl, handleOpen, handleSandbox, navigate, pr])

  return (
    <PRDetailView
      pullRequest={
        pr !== null
          ? AsyncResult.success(pr)
          : loadFailure !== null
            ? AsyncResult.fail(loadFailure)
            : AsyncResult.initial()
      }
      routeAmbiguous={routeAmbiguous}
      now={new Date()}
      health={{ score, unknownReason: scoreUnknownReason }}
      actions={{
        copied,
        isRefreshing,
        isSubscribed,
        sandboxState: stoppingSandbox !== undefined ? "stopping" : existingSandbox !== undefined ? "open" : "create",
        onBack: () => {
          void navigate("/")
        },
        onRefresh: handleRefresh,
        onSubscriptionToggle: handleSubscriptionToggle,
        onSandbox: handleSandbox,
        onCopyLink: handleCopy,
        onOpenConsole: handleOpen,
        onRetryLoad: retryLoad,
        onOpenAccountsSettings: () => {
          void navigate("/settings/accounts")
        }
      }}
      approvals={{
        currentUser: state.currentUser,
        knownUserArns,
        repoAccountId: currentAcct,
        permissionPrompt: state.permissionPrompt !== undefined,
        onRefresh: refreshAfterApprovalMutation,
        onSetApprovers: (kind, arns) => {
          if (pr === null) return
          const required = kind === "required"
          const ruleName = required ? REQUIRED_RULE_NAME : OPTIONAL_RULE_NAME
          const existing = pr.approvalRules.find(
            (rule) => rule.ruleName === ruleName && rule.fromTemplate === undefined
          )
          if (existing !== undefined) {
            updateRule({
              payload: {
                account: pr.account,
                approvalRuleName: existing.ruleName,
                poolMembers: arns.length > 0 ? arns : ["*"],
                pullRequestId: pr.id,
                requiredApprovals: required ? (arns.length > 0 ? arns.length : 0) : 0
              }
            })
          } else if (arns.length > 0) {
            createRule({
              payload: {
                account: pr.account,
                approvalRuleName: ruleName,
                poolMembers: arns,
                pullRequestId: pr.id,
                requiredApprovals: required ? arns.length : 0
              }
            })
          }
        },
        onRemoveRule: (kind) => {
          if (pr === null) return Promise.resolve({ _tag: "DeleteFailed", reason: "Pull request is not loaded." })
          const ruleName = kind === "required" ? REQUIRED_RULE_NAME : OPTIONAL_RULE_NAME
          return deleteRule({
            payload: { account: pr.account, approvalRuleName: ruleName, pullRequestId: pr.id }
          }).then((exit): Promise<RuleRemoval> | RuleRemoval => {
            if (Exit.isSuccess(exit)) {
              return refreshAfterApprovalMutation().then((refreshed) =>
                refreshed ? { _tag: "Removed" } : { _tag: "RefreshFailed" }
              )
            }
            const error = Cause.squash(exit.cause)
            return {
              _tag: "DeleteFailed",
              reason: Predicate.isError(error) ? error.message : "the server didn't answer."
            }
          })
        }
      }}
      comments={{
        count: commentCount,
        navigation: commentNavigation,
        refreshGeneration: commentsRefreshGeneration,
        onCountChange: reconcileCommentCount,
        onNavigateToDiff: (target) => requestCommentNavigation("diff", target)
      }}
      review={{
        accountId: pr === null ? (accountId ?? "") : reviewApiAccountId(pr),
        commentsRefreshGeneration,
        commentNavigation,
        onFindingPosted: refreshCommentsAfterPublication,
        onNavigateToComment: (target) => requestCommentNavigation("comment", target),
        refreshGeneration: reviewRefreshGeneration
      }}
      dialogs={{
        granted: {
          visible: granted.visible,
          dontRemind: granted.dontRemind,
          onOpenChange: granted.cancel,
          onDontRemindChange: granted.setDontRemind,
          onCancel: granted.cancel,
          onContinue: handleGrantedContinue
        },
        docker: {
          visible: docker.visible,
          dontRemind: docker.dontRemind,
          onOpenChange: docker.cancel,
          onDontRemindChange: docker.setDontRemind,
          onCancel: docker.cancel,
          onContinue: handleDockerContinue
        }
      }}
      renderReviewWorkspace={(input) => (
        <PullRequestCommitSummaries accountId={input.accountId} pullRequest={input.pullRequest}>
          <PullRequestReviewWorkspace {...input} />
        </PullRequestCommitSummaries>
      )}
      renderComments={(input) => <CommentsSection {...input} />}
      renderLifecycle={(pr) => <LifecycleInfo pr={pr} />}
    />
  )
}

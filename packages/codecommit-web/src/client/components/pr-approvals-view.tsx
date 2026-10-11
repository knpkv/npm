import {
  approvalOf,
  approvalUnknownLabel,
  approversUnknownLabel,
  currentApprovers
} from "@knpkv/codecommit-core/Domain.js"
import { Button as RlyButton, Field, StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import { CheckIcon, LoaderIcon, PlusIcon, TrashIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useOptimisticSet } from "../hooks/useOptimisticSet.js"
import { normalizeApproverIdentity } from "./pr-detail-presentation.js"
import type { PRApprovalsViewProps } from "./pr-detail-view.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import styles from "./pr-detail.module.css"

export type { PRApprovalActions, PRApprovalsViewProps, PRApproverKind } from "./pr-detail-view.js"

export const REQUIRED_RULE_NAME = "Required approvers"
export const OPTIONAL_RULE_NAME = "Optional approvers"

export interface ApproversCardProps {
  readonly title: string
  readonly ruleName: string
  readonly required: boolean
  readonly approvalRules: ReadonlyArray<{
    readonly ruleName: string
    readonly requiredApprovals: number
    readonly poolMembers: ReadonlyArray<string>
    readonly poolMemberArns: ReadonlyArray<string>
    readonly satisfied: boolean
    readonly fromTemplate?: string | undefined
  }>
  /** Who approved as far as is known now ({@link currentApprovers}): marked with a check. */
  readonly approvedBy: ReadonlyArray<string>
  /** The last approver read failed, so nobody is marked approved and the card says so. */
  readonly approversUnknown: boolean
  /** The last evaluation failed, so each rule's `satisfied` is only its last known value. */
  readonly approvalUnknown: boolean
  readonly knownUserArns: ReadonlyMap<string, string>
  readonly currentUser: string | undefined
  readonly repoAccountId: string
  readonly onSetApprovers: (arns: ReadonlyArray<string>) => void
  /**
   * Deletes this card's own rule (never a template rule), then refreshes the pull request. Says which
   * step failed: a failed refresh is retried with `onRefresh`, never by deleting again.
   */
  readonly onRemoveRule: () => Promise<RuleRemoval>
  readonly onRefresh: () => Promise<boolean>
  readonly permissionPrompt: boolean
}

/** How removing a rule ended. */
export type RuleRemoval =
  | { readonly _tag: "Removed" }
  | { readonly _tag: "DeleteFailed"; readonly reason: string }
  | { readonly _tag: "RefreshFailed" }

export function ApproversCard({
  approvalRules,
  approvalUnknown,
  approvedBy,
  approversUnknown,
  currentUser,
  knownUserArns,
  onRefresh,
  onRemoveRule,
  onSetApprovers,
  permissionPrompt,
  repoAccountId,
  required,
  ruleName,
  title
}: ApproversCardProps) {
  const [showPicker, setShowPicker] = useState(false)
  const [manualArn, setManualArn] = useState("")
  const poolKey = approvalRules.flatMap((r) => r.poolMembers).join(",")
  const optimistic = useOptimisticSet({
    items: approvalRules.flatMap((r) => r.poolMembers),
    stableKey: poolKey,
    permissionPrompt,
    onRefresh
  })
  const { pendingAdd, pendingRemove } = optimistic
  // Removing stays on until the refreshed rules drop the rule (the button goes with it), so it can't be
  // clicked again against a rule that is already gone.
  const [removal, setRemoval] = useState<{ readonly _tag: "Idle" } | { readonly _tag: "Removing" } | RuleRemoval>({
    _tag: "Idle"
  })

  // Pool members for THIS card: template rules + this card's managed rule (not other managed rules)
  const allPoolMembers = useMemo(() => {
    const set = new Set<string>()
    for (const rule of approvalRules) {
      if (rule.fromTemplate !== undefined || rule.ruleName === ruleName) {
        for (const m of rule.poolMembers) set.add(m)
      }
    }
    return [...set]
  }, [approvalRules, ruleName])

  // Find the managed rule by name (non-template rule we can edit)
  const managedRule = approvalRules.find((r) => r.ruleName === ruleName && r.fromTemplate === undefined)
  const managedArns = managedRule?.poolMemberArns ?? []
  const managedMembers = managedRule?.poolMembers ?? []
  const hasManagedRule = managedRule !== undefined
  useEffect(() => {
    if (!hasManagedRule) setRemoval({ _tag: "Idle" })
  }, [hasManagedRule])
  const removeRule = () => {
    setRemoval({ _tag: "Removing" })
    void onRemoveRule().then(setRemoval)
  }
  const refreshAfterRemoval = () => {
    setRemoval({ _tag: "Removing" })
    void onRefresh().then((refreshed) => setRemoval(refreshed ? { _tag: "Removed" } : { _tag: "RefreshFailed" }))
  }

  // Users available to add (have known ARN + not already in pool)
  const addable = useMemo(
    () => [...knownUserArns.entries()].filter(([name]) => !allPoolMembers.includes(name) && name !== pendingAdd),
    [knownUserArns, allPoolMembers, pendingAdd]
  )

  const prefix = repoAccountId.length > 0 ? `CodeCommitApprovers:${repoAccountId}:` : ""

  const handleAdd = (input: string) => {
    const value = normalizeApproverIdentity(input, repoAccountId)
    if (value === undefined) return
    const nameMatch = /^CodeCommitApprovers:[^:]*:(.+)$/.exec(value)
    optimistic.add(nameMatch !== null ? nameMatch[1]! : input)
    onSetApprovers([...managedArns, value])
    setShowPicker(false)
  }

  const handleRemove = (user: string) => {
    optimistic.remove(user)
    const idx = managedMembers.indexOf(user)
    if (idx >= 0) {
      onSetApprovers(managedArns.filter((_, i) => i !== idx))
    }
  }

  const isSatisfied = approvalRules.length > 0 && approvalRules.every((r) => r.satisfied)

  return (
    <Surface as="section" className={styles.approverCard} padding="default" form="grouped" tone="secondary">
      <header className={styles.approverHeading}>
        <div className={styles.approverTitle}>
          <Text as="h3" variant="label">
            {title}
          </Text>
          {required &&
            approvalRules.length > 0 &&
            (approvalUnknown ? (
              <StateLabel label={approvalUnknownLabel} size="compact" tone="neutral" />
            ) : isSatisfied ? (
              <StateLabel label="Satisfied" size="compact" tone="positive" />
            ) : (
              <StateLabel label="Pending" size="compact" tone="caution" />
            ))}
          {approversUnknown && <StateLabel label={approversUnknownLabel} size="compact" tone="neutral" />}
        </div>
        <Button
          aria-expanded={showPicker}
          aria-label={showPicker ? `Close ${title.toLocaleLowerCase()} editor` : `Add ${title.toLocaleLowerCase()}`}
          className={styles.iconAction}
          onClick={() => setShowPicker(!showPicker)}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon className="size-4" />
        </Button>
        {managedRule === undefined ? null : (
          // Only the rule this page created can be removed; template rules belong to the repository.
          <RlyButton
            // Removed and waiting for the refreshed rules to drop it: no second delete.
            disabled={removal._tag === "Removed" || removal._tag === "RefreshFailed"}
            loading={removal._tag === "Removing"}
            onClick={removeRule}
            size="compact"
            variant="quiet"
          >
            Remove rule
          </RlyButton>
        )}
      </header>
      {removal._tag === "DeleteFailed" ? (
        <p className={styles.removeFailure} role="alert">
          Couldn't remove the rule: {removal.reason}
        </p>
      ) : removal._tag === "RefreshFailed" ? (
        <p className={styles.removeFailure} role="alert">
          Removed the rule, but this page couldn't refresh to show it.{" "}
          <RlyButton onClick={refreshAfterRemoval} size="compact" variant="quiet">
            Refresh
          </RlyButton>
        </p>
      ) : null}
      <div className={styles.approverBody}>
        {showPicker && (
          <div className={styles.approverPicker}>
            {addable.length > 0 && (
              <div className={styles.approverSuggestions}>
                {addable.map(([name]) => (
                  <Button
                    className={styles.suggestionChoice}
                    key={name}
                    onClick={() => setManualArn(name)}
                    size="sm"
                    variant="outline"
                  >
                    {name}
                  </Button>
                ))}
              </div>
            )}
            <div className={styles.approverPickerActions}>
              <Field
                className={styles.approverField}
                description="Enter a known user or the complete CodeCommit approver identity."
                label="Approver"
                size="compact"
              >
                {(controlProps) => (
                  <input
                    {...controlProps}
                    className={`${controlProps.className} ${styles.approverInput ?? ""}`}
                    onChange={(event) => setManualArn(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && manualArn.trim().length > 0 && prefix.length > 0) {
                        handleAdd(manualArn.trim())
                        setManualArn("")
                      }
                    }}
                    placeholder={prefix.length > 0 ? `${prefix}USERNAME` : "username"}
                    value={manualArn}
                  />
                )}
              </Field>
              <RlyButton
                disabled={manualArn.trim().length === 0 || prefix.length === 0}
                onClick={() => {
                  handleAdd(manualArn.trim())
                  setManualArn("")
                }}
                size="compact"
                variant="primary"
              >
                Add
              </RlyButton>
            </div>
          </div>
        )}
        {!showPicker && prefix.length > 0 && addable.length > 0 && (
          <div className={styles.suggestedApprovers}>
            <Text tone="secondary" variant="meta">
              Suggested
            </Text>
            {addable.slice(0, 5).map(([name, arn]) => (
              <button className={styles.suggestedApprover} key={name} onClick={() => handleAdd(arn)} type="button">
                <PlusIcon aria-hidden="true" />
                {name}
              </button>
            ))}
          </div>
        )}
        {(allPoolMembers.length > 0 || (pendingAdd !== null && pendingAdd.length > 0)) && (
          <div className={styles.approverMembers}>
            {allPoolMembers.map((member) => {
              const hasApproved = approvedBy.includes(member)
              const isManaged = managedMembers.includes(member)
              const isRemoving = member === pendingRemove
              return (
                <Badge
                  className={`${styles.approverMember ?? ""} ${
                    hasApproved ? "border-green-500/30 text-green-600 dark:text-green-400" : ""
                  } ${isRemoving ? "opacity-50" : ""}`}
                  key={member}
                  variant={member === currentUser ? "default" : hasApproved ? "outline" : "secondary"}
                >
                  {isRemoving && <LoaderIcon className="size-3 animate-spin" />}
                  {!isRemoving && hasApproved && <CheckIcon className="size-3" />}
                  {member}
                  {isManaged && !isRemoving && (
                    <button
                      aria-label={`Remove ${member} from ${title.toLocaleLowerCase()}`}
                      className={styles.removeApprover}
                      onClick={() => handleRemove(member)}
                      type="button"
                    >
                      <TrashIcon className="size-3" />
                    </button>
                  )}
                </Badge>
              )
            })}
            {pendingAdd !== null && pendingAdd.length > 0 && !allPoolMembers.includes(pendingAdd) && (
              <Badge className={`${styles.approverMember ?? ""} opacity-70`} variant="secondary">
                <LoaderIcon className="size-3 animate-spin" />
                {pendingAdd}
              </Badge>
            )}
          </div>
        )}
      </div>
    </Surface>
  )
}

export function PRApprovalsView({ actions, pr }: PRApprovalsViewProps) {
  return (
    <section className={styles.approvalSection}>
      <header className={styles.sectionHeading}>
        <Text as="h2" variant="card-title">
          Decision evidence
        </Text>
        <Text tone="secondary" variant="meta">
          Provider approval rules for this pull request
        </Text>
      </header>
      {[
        { title: "Required Approvers", ruleName: REQUIRED_RULE_NAME, required: true },
        { title: "Optional Approvers", ruleName: OPTIONAL_RULE_NAME, required: false }
      ].map((card) => (
        <ApproversCard
          approvalRules={pr.approvalRules}
          approvalUnknown={approvalOf(pr)._tag === "Unknown"}
          approvedBy={currentApprovers(pr)}
          approversUnknown={pr.approversUnknown === true}
          currentUser={actions.currentUser}
          key={card.ruleName}
          knownUserArns={actions.knownUserArns}
          onRefresh={actions.onRefresh}
          onSetApprovers={(arns) => actions.onSetApprovers(card.required ? "required" : "optional", arns)}
          onRemoveRule={() => actions.onRemoveRule(card.required ? "required" : "optional")}
          permissionPrompt={actions.permissionPrompt}
          repoAccountId={actions.repoAccountId}
          required={card.required}
          ruleName={card.ruleName}
          title={card.title}
        />
      ))}
    </section>
  )
}

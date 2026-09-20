/** Post through the already selected Jira client; never resolve credentials inside this boundary. */
import type { JiraApiClientContract } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import type { JiraWorklogOutcome, WorklogParams } from "../TimerService.js"

const failureMessage = <Input>(error: Input): string => {
  if (!Predicate.isReadonlyObject(error)) return String(error)
  const response = Predicate.isReadonlyObject(error.response) ? error.response : undefined
  const status = Predicate.isNumber(response?.status) ? `HTTP ${response.status}` : "Jira request failed"
  if (!("cause" in error)) return status
  const detail = Predicate.isString(error.cause) ? error.cause : JSON.stringify(error.cause)
  return detail.length === 0 ? status : `${status}: ${detail}`
}

/** The selected client's credential, site, and account must already have been verified by its caller. */
export const postJiraWorklog = (jira: Pick<JiraApiClientContract, "addWorklog">, params: WorklogParams) =>
  Effect.gen(function*() {
    const timeSpent = Math.max(60, Math.floor(params.durationSeconds))
    const started = params.startedAt.toISOString().replace("Z", "+0000")
    yield* Effect.logDebug(`Jira worklog: ${params.ticketKey} ${timeSpent}s`)
    return yield* jira.addWorklog(params.ticketKey, {
      payload: {
        started,
        timeSpentSeconds: timeSpent,
        ...(params.comment && {
          comment: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: params.comment }] }]
          }
        })
      }
    }).pipe(
      Effect.map((worklog): JiraWorklogOutcome => ({ _tag: "Posted", entryId: worklog.id })),
      Effect.catchTag("AddWorklog401", () => Effect.succeed<JiraWorklogOutcome>({ _tag: "NotLoggedIn" })),
      Effect.catch((error) =>
        Effect.logDebug(`Jira worklog failed: ${failureMessage(error)}`).pipe(
          Effect.as<JiraWorklogOutcome>({ _tag: "Failed", message: failureMessage(error) })
        )
      )
    )
  })

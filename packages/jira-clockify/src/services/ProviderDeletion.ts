/** Private positive-evidence probe; absence from a feed is never deletion evidence. */
import type { JiraApiClientContract } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class JiraDeletionEvidenceError extends Schema.TaggedError<JiraDeletionEvidenceError>()(
  "JiraDeletionEvidenceError",
  { message: Schema.String }
) {}

export type JiraDeletionEvidence =
  | { readonly _tag: "DeletedAfterCreation"; readonly updatedTime: number }
  | { readonly _tag: "Unproved" }

const safeTime = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0

const numericEntryId = (entryId: string): number | null => {
  if (!/^[1-9]\d*$/u.test(entryId)) return null
  const value = Number(entryId)
  return Number.isSafeInteger(value) ? value : null
}

/** Only a complete page with an exact post-creation ID is positive evidence, never release authority. */
export const readJiraDeletionEvidence = (
  client: Pick<JiraApiClientContract, "getIdsOfWorklogsDeletedSince">,
  entryId: string,
  createdAtMs: number
): Effect.Effect<JiraDeletionEvidence, JiraDeletionEvidenceError> =>
  Effect.gen(function*() {
    const id = numericEntryId(entryId)
    if (id === null || !safeTime(createdAtMs)) {
      return yield* new JiraDeletionEvidenceError({ message: "Jira binding lacks a safe provider checkpoint or ID" })
    }
    const page = yield* client.getIdsOfWorklogsDeletedSince({ params: { since: createdAtMs } }).pipe(
      Effect.mapError(() => new JiraDeletionEvidenceError({ message: "Jira deletion feed could not be verified" }))
    )
    if (
      !safeTime(page.since) || !safeTime(page.until) || page.until < page.since ||
      page.lastPage === undefined || page.values === undefined ||
      page.lastPage === false && (page.nextPage === undefined || page.nextPage === "")
    ) {
      return yield* new JiraDeletionEvidenceError({ message: "Jira deletion page is incomplete" })
    }
    let previous = page.since
    for (const row of page.values) {
      if (
        !safeTime(row.worklogId) || row.worklogId <= 0 || !safeTime(row.updatedTime) ||
        row.updatedTime < previous || row.updatedTime > page.until
      ) {
        return yield* new JiraDeletionEvidenceError({ message: "Jira deletion page has invalid ordering or identity" })
      }
      previous = row.updatedTime
    }
    const matchedTime = page.values.find((row) =>
      row.worklogId === id && row.updatedTime !== undefined && row.updatedTime > createdAtMs
    )?.updatedTime
    return matchedTime === undefined
      ? { _tag: "Unproved" }
      : { _tag: "DeletedAfterCreation", updatedTime: matchedTime }
  })

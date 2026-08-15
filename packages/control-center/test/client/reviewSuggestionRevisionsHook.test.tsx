// @vitest-environment happy-dom

import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Schema from "effect/Schema"

import {
  useReviewSuggestionRevisions,
  type ReviewSuggestionRevisionScope,
  type ReviewSuggestionRevisionState,
  type ReviewSuggestionRevisionTransport
} from "../../src/client/entities/useReviewSuggestionRevisions.js"
import { EntityId, JobId, PersonId, PrReviewSuggestionRevisionId } from "../../src/domain/identifiers.js"
import { PrReviewPath, PrReviewSubject, PrReviewSuggestion, PrReviewSuggestionId } from "../../src/domain/prReview.js"
import {
  PrReviewSuggestionOperatorAuthor,
  PrReviewSuggestionRevision,
  PrReviewSuggestionRevisionPage,
  PrReviewSuggestionRevisionSequence,
  PrReviewSuggestionValidated,
  type PrReviewSuggestionEdit
} from "../../src/domain/prReviewRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

interface RevisionStateRef {
  current: ReviewSuggestionRevisionState
}

const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000901")
const OTHER_ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000902")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000903")
const PERSON_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000904")
const SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"5".repeat(64)}`)
const SUBJECT = PrReviewSubject.make({
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "279",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
})
const CREATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-26T20:00:00.000Z")
const SUGGESTION = PrReviewSuggestion.make({
  suggestionId: SUGGESTION_ID,
  state: "draft",
  title: "Authorize before mutating",
  severity: "P2",
  problem: "The mutation precedes authorization.",
  impact: "An unauthorized caller can change state.",
  evidence: {
    path: PrReviewPath.make("src/authorization.ts"),
    startLine: 42,
    endLine: 42,
    excerpt: "yield* mutate()"
  },
  recommendation: "Authorize first.",
  anchor: {
    _tag: "line",
    path: PrReviewPath.make("src/authorization.ts"),
    line: 42,
    relativeFileVersion: "AFTER"
  },
  relatedLocations: [],
  confidence: {
    level: "high",
    reason: "The execution order is explicit."
  }
})
const EDIT: PrReviewSuggestionEdit = {
  ...SUGGESTION,
  title: "Authorize before changing durable state"
}

const revision = (sequence: number, title = SUGGESTION.title) => {
  const revisionId = PrReviewSuggestionRevisionId.make(`sha256:${String(sequence).repeat(64)}`)
  return new PrReviewSuggestionRevision({
    revisionId,
    sequence: PrReviewSuggestionRevisionSequence.make(sequence),
    predecessorRevisionId:
      sequence === 1 ? null : PrReviewSuggestionRevisionId.make(`sha256:${String(sequence - 1).repeat(64)}`),
    sourceJobId: JOB_ID,
    subject: SUBJECT,
    suggestion: PrReviewSuggestion.make({ ...SUGGESTION, title }),
    validation: new PrReviewSuggestionValidated({
      reviewedHead: SUBJECT.headRevision,
      validatingJobId: JOB_ID,
      sourceRevisionId: revisionId
    }),
    author: new PrReviewSuggestionOperatorAuthor({ personId: PERSON_ID }),
    createdAt: CREATED_AT
  })
}

const page = (
  current: PrReviewSuggestionRevision,
  revisions: ReadonlyArray<PrReviewSuggestionRevision> = [current],
  hasMore = false
) =>
  PrReviewSuggestionRevisionPage.make({
    current,
    revisions,
    hasMore,
    nextBeforeSequence: hasMore
      ? PrReviewSuggestionRevisionSequence.make(Math.min(...revisions.map(({ sequence }) => sequence)))
      : null
  })

const scope = (entityId: ReviewSuggestionRevisionScope["entityId"] = ENTITY_ID): ReviewSuggestionRevisionScope => ({
  entityId,
  jobId: JOB_ID,
  sessionKey: "session-a",
  suggestionId: SUGGESTION_ID
})

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const deferred = <Value,>() => {
  let resolveValue: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve
  })
  return {
    promise,
    resolve: (value: Value) => {
      if (resolveValue === undefined) throw new Error("Deferred unavailable")
      resolveValue(value)
    }
  }
}

const Harness = ({
  currentScope,
  onState,
  transport
}: {
  readonly currentScope: ReviewSuggestionRevisionScope | null
  readonly onState: (state: ReviewSuggestionRevisionState) => void
  readonly transport: ReviewSuggestionRevisionTransport
}): ReactElement => {
  const controller = useReviewSuggestionRevisions(currentScope, transport)
  onState(controller.state)
  return (
    <>
      <button data-save onClick={() => controller.save(EDIT)}>
        Save
      </button>
      <button data-earlier onClick={controller.loadEarlier}>
        Earlier
      </button>
      <button data-retry onClick={controller.retry}>
        Retry
      </button>
      <button data-resolve-conflict onClick={controller.resolveConflict}>
        Use latest
      </button>
      <span data-state>{controller.state._tag}</span>
    </>
  )
}

const mount = async (
  currentScope: ReviewSuggestionRevisionScope | null,
  transport: ReviewSuggestionRevisionTransport,
  onState: (state: ReviewSuggestionRevisionState) => void
) => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(<Harness currentScope={currentScope} onState={onState} transport={transport} />))
}

describe("useReviewSuggestionRevisions", () => {
  it("loads, saves against the exact current revision, and refreshes", async () => {
    const original = revision(1)
    const edited = revision(2, EDIT.title)
    const load = vi
      .fn()
      .mockResolvedValueOnce(page(original))
      .mockResolvedValueOnce(page(edited, [edited, original]))
    const edit = vi.fn(() => Promise.resolve(edited))
    const latest: RevisionStateRef = {
      current: { _tag: "idle" }
    }
    await mount(scope(), { load, edit }, (state) => {
      latest.current = state
    })
    await act(async () => undefined)
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-save]")?.click())
    await act(async () => undefined)

    expect(edit).toHaveBeenCalledWith(
      scope(),
      {
        expectedRevisionId: original.revisionId,
        expectedSequence: original.sequence,
        edit: EDIT
      },
      expect.any(AbortSignal)
    )
    expect(latest.current._tag).toBe("ready")
    if (latest.current._tag === "ready") {
      expect(latest.current.page.current.sequence).toBe(2)
    }
  })

  it("retains an accepted revision when its follow-up refresh fails", async () => {
    const original = revision(1)
    const accepted = revision(2, EDIT.title)
    const load = vi
      .fn()
      .mockResolvedValueOnce(page(original))
      .mockRejectedValueOnce(new Error("Refresh unavailable"))
      .mockResolvedValueOnce(page(accepted, [original]))
    const edit = vi.fn(() => Promise.resolve(accepted))
    const latest: RevisionStateRef = {
      current: { _tag: "idle" }
    }
    await mount(scope(), { load, edit }, (state) => {
      latest.current = state
    })
    await act(async () => undefined)
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-save]")?.click())
    await act(async () => undefined)

    expect(latest.current._tag).toBe("failed")
    if (latest.current._tag === "failed") {
      expect(latest.current.draft).toBeNull()
      expect(latest.current.page?.current.revisionId).toBe(accepted.revisionId)
    }
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-retry]")?.click())
    await act(async () => undefined)

    expect(edit).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledTimes(3)
    expect(latest.current._tag).toBe("ready")
  })

  it("retains the local draft and reloads the winner after a conflict", async () => {
    const original = revision(1)
    const winner = new PrReviewSuggestionRevision({
      ...revision(2, "Another edit won"),
      suggestion: PrReviewSuggestion.make({
        ...SUGGESTION,
        title: "Another edit won",
        impact: "The winner changed this impact."
      })
    })
    const edit = vi.fn(() => Promise.reject({ _tag: "ConflictApiError" }))
    const transport: ReviewSuggestionRevisionTransport = {
      load: vi
        .fn()
        .mockResolvedValueOnce(page(original))
        .mockResolvedValueOnce(page(winner, [winner, original])),
      edit
    }
    const latest: RevisionStateRef = {
      current: { _tag: "idle" }
    }
    await mount(scope(), transport, (state) => {
      latest.current = state
    })
    await act(async () => undefined)
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-save]")?.click())
    await act(async () => undefined)

    expect(latest.current._tag).toBe("conflict")
    if (latest.current._tag === "conflict") {
      expect(latest.current.draft.title).toBe(EDIT.title)
      expect(latest.current.page.current.suggestion.title).toBe("Another edit won")
    }
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-save]")?.click())
    expect(edit).toHaveBeenCalledOnce()
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-resolve-conflict]")?.click())
    expect(latest.current._tag).toBe("ready")
    if (latest.current._tag === "ready") {
      expect(latest.current.page.current.suggestion.impact).toBe("The winner changed this impact.")
    }
  })

  it("drops a stale response after the entity scope changes", async () => {
    const stale = deferred<ReturnType<typeof page>>()
    const fresh = page(revision(2))
    const transport: ReviewSuggestionRevisionTransport = {
      load: vi.fn((currentScope) => (currentScope.entityId === ENTITY_ID ? stale.promise : Promise.resolve(fresh))),
      edit: () => Promise.reject(new Error("Unexpected edit"))
    }
    const latest: RevisionStateRef = {
      current: { _tag: "idle" }
    }
    await mount(scope(), transport, (state) => {
      latest.current = state
    })
    await act(async () =>
      root?.render(
        <Harness
          currentScope={scope(OTHER_ENTITY_ID)}
          onState={(state) => {
            latest.current = state
          }}
          transport={transport}
        />
      )
    )
    await act(async () => undefined)
    stale.resolve(page(revision(1)))
    await act(async () => undefined)

    expect(latest.current._tag).toBe("ready")
    if (latest.current._tag === "ready") {
      expect(latest.current.page.current.sequence).toBe(2)
    }
  })

  it("merges bounded earlier pages without duplicating revisions", async () => {
    const third = revision(3)
    const second = revision(2)
    const first = revision(1)
    const transport: ReviewSuggestionRevisionTransport = {
      load: vi
        .fn()
        .mockResolvedValueOnce(page(third, [third, second], true))
        .mockResolvedValueOnce(page(third, [second, first])),
      edit: () => Promise.reject(new Error("Unexpected edit"))
    }
    const latest: RevisionStateRef = {
      current: { _tag: "idle" }
    }
    await mount(scope(), transport, (state) => {
      latest.current = state
    })
    await act(async () => undefined)
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-earlier]")?.click())
    await act(async () => undefined)

    expect(latest.current._tag).toBe("ready")
    if (latest.current._tag === "ready") {
      expect(latest.current.page.current.sequence).toBe(3)
      expect(latest.current.page.revisions.map(({ sequence }) => sequence)).toEqual([2, 1])
    }
  })

  it("adopts a concurrently appended current revision and retains the displaced current", async () => {
    const fourth = revision(4, "Newest concurrent edit")
    const third = revision(3, "Previously displayed edit")
    const second = revision(2)
    const first = revision(1)
    const transport: ReviewSuggestionRevisionTransport = {
      load: vi
        .fn()
        .mockResolvedValueOnce(page(third, [second], true))
        .mockResolvedValueOnce(page(fourth, [second, first])),
      edit: () => Promise.reject(new Error("Unexpected edit"))
    }
    const latest: RevisionStateRef = {
      current: { _tag: "idle" }
    }
    await mount(scope(), transport, (state) => {
      latest.current = state
    })
    await act(async () => undefined)
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-earlier]")?.click())
    await act(async () => undefined)

    expect(latest.current._tag).toBe("ready")
    if (latest.current._tag === "ready") {
      expect(latest.current.page.current.sequence).toBe(4)
      expect(latest.current.page.revisions.map(({ sequence }) => sequence)).toEqual([3, 2, 1])
    }
  })

  it("starts only one earlier-page request while pagination is in flight", async () => {
    const third = revision(3)
    const second = revision(2)
    const earlier = deferred<ReturnType<typeof page>>()
    const load = vi
      .fn()
      .mockResolvedValueOnce(page(third, [second], true))
      .mockReturnValueOnce(earlier.promise)
    const latest: RevisionStateRef = {
      current: { _tag: "idle" }
    }
    await mount(
      scope(),
      {
        load,
        edit: () => Promise.reject(new Error("Unexpected edit"))
      },
      (state) => {
        latest.current = state
      }
    )
    await act(async () => undefined)
    const button = host?.querySelector<HTMLButtonElement>("[data-earlier]")
    await act(async () => {
      button?.click()
      button?.click()
    })

    expect(load).toHaveBeenCalledTimes(2)
    earlier.resolve(page(third, [revision(1)]))
    await act(async () => undefined)
    expect(latest.current._tag).toBe("ready")
  })

  it("preserves a conflict draft across failed and successful history reads", async () => {
    const original = revision(1)
    const winner = revision(2, "Another edit won")
    const load = vi
      .fn()
      .mockResolvedValueOnce(page(original))
      .mockResolvedValueOnce(page(winner, [original], true))
      .mockRejectedValueOnce(new Error("History temporarily unavailable"))
      .mockResolvedValueOnce(page(winner, [original]))
    const transport: ReviewSuggestionRevisionTransport = {
      load,
      edit: () => Promise.reject({ _tag: "ConflictApiError" })
    }
    const latest: RevisionStateRef = {
      current: { _tag: "idle" }
    }
    await mount(scope(), transport, (state) => {
      latest.current = state
    })
    await act(async () => undefined)
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-save]")?.click())
    await act(async () => undefined)
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-earlier]")?.click())
    await act(async () => undefined)

    expect(latest.current._tag).toBe("conflict")
    if (latest.current._tag === "conflict") {
      expect(latest.current.draft.title).toBe(EDIT.title)
    }
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-retry]")?.click())
    expect(load).toHaveBeenCalledTimes(3)
    await act(async () => host?.querySelector<HTMLButtonElement>("[data-earlier]")?.click())
    await act(async () => undefined)

    expect(latest.current._tag).toBe("conflict")
    if (latest.current._tag === "conflict") {
      expect(latest.current.draft.title).toBe(EDIT.title)
      expect(latest.current.page.current.sequence).toBe(2)
    }
  })
})

/**
 * Ask a Coding Agent two things about an Agent Session: which Issue Key it was *worked on*, among
 * the keys the session itself mentions, and what was done in it.
 *
 * **Mental model**
 *
 * - **Two questions, one boundary**: attribution decides *where* time goes, description says *what*
 *   the time was. They share this module because they share the model, the batching and the
 *   no-tools policy — and because keeping `LanguageModel` in one place is the point of the seam.
 *
 * - **Last resort, in batches**: attribution is asked for only where no deterministic Attribution
 *   Signal could place a session — long-lived integration branches, mostly — so a run of
 *   branch-attributed work never asks it at all. Description is asked for only about the rows a user
 *   has *confirmed*, so nothing is spent describing a row that is never written. Either way the
 *   outstanding work goes in one call, because a call's cost is almost entirely fixed overhead.
 * - **Closed choice set**: the candidates come from the transcript's own text and a key outside
 *   that set is rejected by the caller, so an invented Issue Key is structurally impossible
 *   rather than merely discouraged by the prompt.
 * - **"None" is a first-class answer**: a release-notes document mentions dozens of tickets it
 *   describes and works on none of them. Frequency is anti-correlated with what should be
 *   billed, so the question asked is "worked on, or only referenced?".
 *
 * **Gotchas**
 *
 * - The narrow interface is deliberate: `LanguageModel` stays inside this module so no consumer
 *   or test has to know a model exists.
 * - Failures are typed, not fatal. A caller that cannot reach a Coding Agent still reports the
 *   deterministic proposals and lists the rest as Unattributed Sessions.
 *
 * @module
 */
import { model as claudeModel } from "@knpkv/ai-claude"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { LanguageModel } from "effect/unstable/ai"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { HomeDirectory } from "./HomeDirectory.js"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** What a Coding Agent decided about one session. `None` is an expected, correct outcome. */
export type AttributionChoice =
  | { readonly _tag: "Chosen"; readonly ticketKey: string; readonly confidence: number }
  | { readonly _tag: "None" }

export interface SessionAttributorRequest {
  /** Identifies the answer in the reply. Batched calls need it; a single call ignores it. */
  readonly sessionId: string
  /** The only Issue Keys that may be chosen — mined from the transcript. */
  readonly candidateKeys: ReadonlyArray<string>
  /** Bounded digest of the session's prompts. */
  readonly digest: string
}

/** One session's answer, paired back to the request that produced it. */
export interface SessionAttributorAnswer {
  readonly sessionId: string
  readonly choice: AttributionChoice
}

/** One work item to describe, and the prompts to describe it from. */
export interface SessionDescribeRequest {
  /** Identifies the answer in the reply, the same way `sessionId` does for attribution. */
  readonly id: string
  readonly ticketKey: string
  /** The Jira issue title, when known — context for the sentence, never the sentence itself. */
  readonly summary: string | null
  /** Bounded digests of the sessions behind the work item, already joined. */
  readonly digest: string
}

/** One work item's note, or null when the prompts do not say what was done. */
export interface SessionDescribeAnswer {
  readonly id: string
  readonly note: string | null
}

export class SessionAttributorError extends Data.TaggedError("SessionAttributorError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface SessionAttributorContract {
  /**
   * Attribute a batch of sessions in one call.
   *
   * Batched because the cost of a call is almost entirely fixed overhead: measured against the real
   * CLI, one session cost $0.080 and 6.3s while seven in a single call cost $0.049 and 10.2s — an
   * order of magnitude per session. The caller decides how large a batch to send.
   *
   * A session with no answer in the reply comes back as `None` rather than going missing.
   */
  readonly attribute: (
    requests: ReadonlyArray<SessionAttributorRequest>
  ) => Effect.Effect<ReadonlyArray<SessionAttributorAnswer>, SessionAttributorError>

  /**
   * Describe what each work item was: one short sentence per item, read off the session prompts.
   *
   * This is what a worklog is missing when it says only "reconciled from an Agent Session" — months
   * later the question asked of an entry is *what* the time went on, and the transcripts are the only
   * record that still answers it.
   *
   * Batched for the same reason attribution is, and answered in request order so a reordered or
   * partial reply cannot move one item's sentence onto another's worklog. An item with no answer
   * comes back as null rather than going missing.
   */
  readonly describe: (
    requests: ReadonlyArray<SessionDescribeRequest>
  ) => Effect.Effect<ReadonlyArray<SessionDescribeAnswer>, SessionAttributorError>
}

export class SessionAttributor extends Context.Service<SessionAttributor, SessionAttributorContract>()(
  "jcf/SessionAttributor"
) {}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const Answer = Schema.Struct({
  /** Echoes the session the answer is for, so a reordered or partial reply still lines up. */
  sessionId: Schema.String,
  /** One of *that session's* candidates, or null for "none of these". */
  ticketKey: Schema.NullOr(Schema.String),
  /** How sure the choice is, 0 to 1. */
  confidence: Schema.Number,
  /** One short sentence of justification. Requested to improve the choice; not displayed. */
  reason: Schema.String
})

const Answers = Schema.Struct({ answers: Schema.Array(Answer) })

/**
 * One prompt covering every session in the batch, each with its *own* candidate list.
 *
 * Keeping the candidate lists per session is what makes batching safe: an answer naming a key from
 * a different session's list is rejected downstream, because a choice is only accepted when it
 * appears in the candidates of the session it claims to describe.
 */
const buildPrompt = (requests: ReadonlyArray<SessionAttributorRequest>): string =>
  [
    "For each coding session below, decide which Jira issue it was WORKED ON.",
    "",
    "Answer once per session, echoing its id. Choose only from that session's own candidate list, or",
    "null. A session's answer must never use a key from another session's list.",
    "",
    "An issue that is merely REFERENCED is not the answer. A release-notes or known-issues document",
    "mentions many issues it describes while working on none of them, and mentioning an issue often",
    "says nothing about whether it was worked on. If a session's real subject is not among its own",
    "candidates, or you cannot tell, answer with ticketKey: null.",
    "",
    "Set confidence between 0 and 1: how sure you are that the session's work should be logged",
    "against that issue.",
    "",
    ...requests.flatMap((request) => [
      `--- session ${request.sessionId} ---`,
      `Candidates: ${request.candidateKeys.join(", ")}`,
      "Digest:",
      request.digest,
      ""
    ])
  ].join("\n")

/** The longest note that belongs on a worklog line. Past this it stops being a summary. */
const MAX_NOTE_CHARS = 120

const Note = Schema.Struct({
  /** Echoes the work item the note is for, so a reordered or partial reply still lines up. */
  id: Schema.String,
  /** One sentence, or null when the digest does not say what was done. */
  note: Schema.NullOr(Schema.String)
})

const Notes = Schema.Struct({ notes: Schema.Array(Note) })

/**
 * One prompt covering every work item in the batch.
 *
 * The instructions are mostly prohibitions, because the failure mode here is not a wrong sentence
 * but a *padded* one: a worklog line has no room for a preamble, a restatement of the issue title, or
 * an apology for uncertainty. Silence is a correct answer and is asked for explicitly, so a session
 * whose prompts say nothing useful produces no note rather than an invented one.
 */
const buildDescribePrompt = (requests: ReadonlyArray<SessionDescribeRequest>): string =>
  [
    "For each work item below, write ONE short sentence saying what was actually done, read from the",
    "session prompts.",
    "",
    "Answer once per item, echoing its id. Rules:",
    `- Past tense, at most ${MAX_NOTE_CHARS} characters, no trailing full stop.`,
    "- Describe the work, not the conversation: no \"asked about\", no \"discussed\", no \"the user\".",
    "- Do not repeat the issue key or the issue title, and do not add a preamble.",
    "- If the prompts do not say what was done, answer with note: null. Do not guess.",
    "",
    ...requests.flatMap((request) => [
      `--- item ${request.id} ---`,
      `Issue: ${request.ticketKey}${request.summary === null ? "" : ` — ${request.summary}`}`,
      "Digest:",
      request.digest,
      ""
    ])
  ].join("\n")

/**
 * Per-call ceiling. The provider default is two minutes, which is a long time to wait for a
 * one-line classification when a run makes several calls.
 *
 * Measured, not guessed: at 45 seconds two of seven real sessions timed out, because several CLI
 * processes run at once and compete for the machine. 90 seconds cleared them while still bounding
 * a run to roughly two rounds. A session that does time out is reported as unattributed, which is
 * the safe direction.
 */
const ATTRIBUTION_TIMEOUT = "90 seconds"

const clipNote = (note: string): string =>
  note.length <= MAX_NOTE_CHARS ? note : `${note.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…`

const clampConfidence = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  SessionAttributor,
  Effect.gen(function*() {
    const home = (yield* HomeDirectory).path
    // The home directory only satisfies the CLI's cwd requirement; with no tools granted, nothing
    // there is reachable.
    // Two minutes (the provider default) is a long time to wait for a one-line classification, and
    // a run may make several of these calls. Fail fast instead: an unanswered session is reported
    // as unattributed, which is a far better outcome than a command that looks hung.
    // No tools: the prompt carries the candidates and the digest, so there is nothing on disk to
    // consult. Given file tools the CLI goes exploring first — measured at 42s over 6 turns against
    // 15s over 2 with none, which is the difference between fitting the timeout and losing a batch.
    const provider = claudeModel({ cwd: home, access: "none", timeout: ATTRIBUTION_TIMEOUT })
    // Bound here so the spawner stays a requirement of the *layer*, not of every `attribute`
    // call — the service's error and requirement channels are the whole point of this boundary.
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const attribute = (requests: ReadonlyArray<SessionAttributorRequest>) =>
      Effect.gen(function*() {
        // Nothing to choose from anywhere — no point spending a call to learn that.
        const askable = requests.filter((request) => request.candidateKeys.length > 0)
        const none = (sessionId: string): SessionAttributorAnswer => ({
          sessionId,
          choice: { _tag: "None" }
        })
        if (askable.length === 0) return requests.map((request) => none(request.sessionId))

        const response = yield* LanguageModel.generateObject({
          prompt: buildPrompt(askable),
          schema: Answers,
          objectName: "attributions"
        }).pipe(
          // The provider is built per call and lives exactly as long as the call does, which is the
          // scope this diagnostic exists to protect rather than one it puts at risk.
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(provider),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) =>
            new SessionAttributorError({ message: `Coding Agent attribution failed: ${cause.message}`, cause })
          )
        )

        const bySession = new Map(response.value.answers.map((answer) => [answer.sessionId, answer]))
        // Answered in request order, so a reply that omits, duplicates or reorders sessions cannot
        // shift an answer onto the wrong one.
        return requests.map((request): SessionAttributorAnswer => {
          const answer = bySession.get(request.sessionId)
          if (answer === undefined || answer.ticketKey === null) return none(request.sessionId)
          return {
            sessionId: request.sessionId,
            choice: {
              _tag: "Chosen",
              ticketKey: answer.ticketKey,
              confidence: clampConfidence(answer.confidence)
            }
          }
        })
      })

    const describe = (requests: ReadonlyArray<SessionDescribeRequest>) =>
      Effect.gen(function*() {
        // Nothing to read means nothing to say, and no reason to spend a call learning that.
        const askable = requests.filter((request) => request.digest.trim() !== "")
        const silent = (id: string): SessionDescribeAnswer => ({ id, note: null })
        if (askable.length === 0) return requests.map((request) => silent(request.id))

        const response = yield* LanguageModel.generateObject({
          prompt: buildDescribePrompt(askable),
          schema: Notes,
          objectName: "notes"
        }).pipe(
          // The provider is built per call and lives exactly as long as the call does, which is the
          // scope this diagnostic exists to protect rather than one it puts at risk.
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(provider),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) =>
            new SessionAttributorError({ message: `Coding Agent description failed: ${cause.message}`, cause })
          )
        )

        const byId = new Map(response.value.notes.map((note) => [note.id, note]))
        return requests.map((request): SessionDescribeAnswer => {
          const answer = byId.get(request.id)
          if (answer === undefined || answer.note === null) return silent(request.id)
          const note = answer.note.trim()
          // Clipped rather than rejected: an over-long sentence is still a useful one, and a worklog
          // line is the wrong place to find out that a model ignored a character budget.
          return { id: request.id, note: note === "" ? null : clipNote(note) }
        })
      })

    return { attribute, describe }
  })
)

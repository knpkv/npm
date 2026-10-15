/** Reads trusted CI publications as data. Never imports a stack, runs Alchemy or touches provider state. */
import { Clock, Config, Context, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect"
import type { PlanSource, PlanState, PublishedPlan } from "../plan.js"
import { archiveLimit, archiveText } from "./plan/archive.js"
import {
  type Artifact,
  type GithubFailure,
  githubLayer,
  type Job,
  PlanCiUnreachable,
  PlanGithub,
  PlanMetadataInvalid,
  publishedMillis,
  type Run
} from "./plan/github.js"
import {
  decodeReceipt,
  hashBytes,
  type InfraStack,
  PlanDigestMismatch,
  type Receipt,
  stageFor
} from "./plan/receipt.js"

export class PlanProvenanceInvalid extends Schema.TaggedError<PlanProvenanceInvalid>()("PlanProvenanceInvalid", {}) {}

export class PlanReader extends Context.Service<PlanReader, {
  readonly read: (app: string, stage: string) => Effect.Effect<PlanState>
}>()("@knpkv/alchemy-console/PlanReader") {}

/** Explicit app/stage allowlist. Similar names and unrelated stages do not inherit a CI source. */
const mappedStack = (app: string, stage: string): InfraStack | null =>
  app === "site" && stage === "prod" ? "site" : app === "aws-org" && stage === "org" ? "aws-org" : null
const repoId = 1288997422
const compareProducerRuns = (a: Run, b: Run): number =>
  DateTime.toEpochMillis(b.run_started_at) - DateTime.toEpochMillis(a.run_started_at) || b.id - a.id ||
  b.run_attempt - a.run_attempt
const runHref = (id: number): string => `https://github.com/knpkv/infra/actions/runs/${id}`
const sourceFor = (artifact: Artifact, head: string, now: number, producer: Run | undefined): PlanSource => ({
  pr: producer?.pull_requests.find((pr) => pr.head.sha === head)?.number ?? null,
  head: head.slice(0, 7),
  base: null,
  publishedAt: DateTime.formatIso(artifact.created_at),
  ageDays: Math.max(0, Math.floor(now / 86_400_000) - Math.floor(publishedMillis(artifact) / 86_400_000)),
  runHref: runHref(artifact.workflow_run.id)
})
const QualifiedWorkflowPath = Schema.TemplateLiteralParser([
  ".github/workflows/",
  Schema.Literals(["infra.yml", "infra-publish.yml"]),
  "@",
  Schema.NonEmptyString.check(Schema.isPattern(/^[^@]+$/u))
])
/** GitHub can qualify a workflow filename with a branch or PR merge ref; neither part is a prefix match. */
const workflowPathMatches = (run: Run, file: "infra.yml" | "infra-publish.yml"): boolean => {
  if (run.path === `.github/workflows/${file}`) return true
  const qualified = Option.getOrNull(Schema.decodeUnknownOption(QualifiedWorkflowPath)(run.path))
  if (qualified === null || qualified[1] !== file) return false
  const ref = qualified[3]
  return ref === "main" || ref === "refs/heads/main" ||
    (file === "infra.yml" && (
      ref === run.head_branch || ref === `refs/heads/${run.head_branch}` ||
      run.pull_requests.some((pr) => ref === `refs/pull/${pr.number}/merge`)
    ))
}
const privateRunMatches = (
  run: Run,
  workflowId: number,
  file: "infra.yml" | "infra-publish.yml",
  event: string
): boolean =>
  run.workflow_id === workflowId && workflowPathMatches(run, file) && run.event === event &&
  run.repository.id === repoId && run.head_repository.id === repoId &&
  run.actor.id === 833092 && run.triggering_actor.id === 833092

const project = (
  receipt: Receipt,
  source: PlanSource,
  latestMainSeenByCi: string | null,
  now: number,
  artifact: Artifact
): PublishedPlan => ({
  source: { ...source, pr: receipt.pr, base: receipt.base.slice(0, 7) },
  digest: `${receipt.native.digest.slice(0, 4)}…${receipt.native.digest.slice(-4)}`,
  rows: receipt.native.semantic.rows.map((row) => ({
    fqn: row.fqn,
    resourceType: row.type,
    action: row.action,
    changedKeys: [...row.changedKeys]
  })),
  stale: latestMainSeenByCi !== null && receipt.base !== latestMainSeenByCi
    ? "base"
    : now - publishedMillis(artifact) > 86_400_000
    ? "age"
    : null
})

/** One typed failure class per refusal, transport, metadata, provenance, archive, digest and receipt boundary. */
export const readerLayer = Layer.effect(
  PlanReader,
  Effect.gen(function*() {
    const github = yield* PlanGithub
    const cryptoService = yield* Crypto.Crypto
    const read = Effect.fn("AlchemyConsole.readCiPlan")(
      function*(
        app: string,
        stage: string
      ): Effect.fn.Return<PlanState, GithubFailure | PlanProvenanceInvalid, Crypto.Crypto> {
        const stack = mappedStack(app, stage)
        if (stack === null) return { _tag: "NotConnected" }
        const now = yield* Clock.currentTimeMillis
        const publisherWorkflow = yield* github.workflow("infra-publish.yml")
        const producerWorkflow = yield* github.workflow("infra.yml")
        if (
          publisherWorkflow.path !== ".github/workflows/infra-publish.yml" ||
          producerWorkflow.path !== ".github/workflows/infra.yml"
        ) {
          return yield* new PlanProvenanceInvalid({})
        }
        const publishing = publisherWorkflow.state === "active" && producerWorkflow.state === "active"
        if (!publishing) return { _tag: "NotPublishing" }
        const producerRuns = (yield* github.runs("infra.yml")).filter((run) =>
          privateRunMatches(run, producerWorkflow.id, "infra.yml", "pull_request")
        ).sort(compareProducerRuns)
        const latest = producerRuns[0]
        const jobs = latest === undefined ? [] : yield* github.jobs(latest.id)
        const paused = jobs.length > 0 && jobs.every((job) => job.conclusion === "skipped")
        if (paused) return { _tag: "NotPublishing" }
        // A successful matrix job can skip this stack. Only the actual native-plan step proves an attempt.
        let attempt: { readonly run: Run; readonly job: Job } | undefined
        for (const [index, run] of producerRuns.entries()) {
          const runJobs = index === 0 ? jobs : yield* github.jobs(run.id)
          const nativeJobs = runJobs.filter((job) => job.name === `${stack} / native`)
          if (nativeJobs.length > 1) return yield* new PlanMetadataInvalid({})
          const job = nativeJobs[0]
          if (job === undefined) continue
          if (job.run_attempt !== run.run_attempt) return yield* new PlanProvenanceInvalid({})
          const nativeSteps = job.steps.filter((step) => step.name === "Native read-only plan")
          if (nativeSteps.length > 1) return yield* new PlanMetadataInvalid({})
          const step = nativeSteps[0]
          if (
            step === undefined || step.started_at === undefined || step.started_at === null ||
            step.status === "queued" || step.conclusion === "skipped"
          ) continue
          if (step.status !== "completed" && step.status !== "in_progress") return yield* new PlanMetadataInvalid({})
          attempt = { run, job }
          break
        }
        const failed = attempt?.job.status === "completed" &&
            ["failure", "cancelled", "timed_out", "action_required", "stale"].includes(attempt.job.conclusion ?? "")
          ? attempt.run :
          undefined
        const artifacts = (yield* github.artifacts(stack)).filter((artifact) =>
          artifact.name.startsWith(`infra-plan-${stack}-`)
        )
          .sort((a, b) => publishedMillis(b) - publishedMillis(a) || b.id - a.id)
        const selected = artifacts.find((artifact) =>
          !artifact.expired && DateTime.toEpochMillis(artifact.expires_at) > now
        )
        if (selected === undefined) {
          if (failed !== undefined) return { _tag: "Failed", runHref: runHref(failed.id), lastPublished: null }
          const expired = artifacts[0]
          if (expired === undefined) return { _tag: "NotPublished" }
          const match = expired.name.match(new RegExp(`^infra-plan-${stack}-([a-f0-9]{40})$`))
          const head = match?.[1]
          return {
            _tag: "Expired",
            source: head === undefined
              ? null
              : sourceFor(
                expired,
                head,
                now,
                producerRuns.find((run) => run.head_sha === head)
              )
          }
        }
        const artifact = selected
        const head = artifact.name.slice(`infra-plan-${stack}-`.length)
        const producer = producerRuns.find((run) => run.head_sha === head)
        const source = /^[a-f0-9]{40}$/.test(head) ? sourceFor(artifact, head, now, producer) : null
        const verified = Effect.gen(function*() {
          if (
            source === null || artifact.digest === null || artifact.size_in_bytes >= archiveLimit ||
            artifact.workflow_run.repository_id !== repoId || artifact.workflow_run.head_repository_id !== repoId ||
            artifact.workflow_run.head_branch !== "main"
          ) return yield* new PlanProvenanceInvalid({})
          const publisher = yield* github.run(artifact.workflow_run.id)
          if (
            !privateRunMatches(publisher, publisherWorkflow.id, "infra-publish.yml", "workflow_run") ||
            publisher.head_branch !== "main" || publisher.status !== "completed" ||
            publisher.conclusion !== "success" ||
            publisher.head_sha !== artifact.workflow_run.head_sha
          ) return yield* new PlanProvenanceInvalid({})
          const bytes = yield* github.download(artifact.id)
          if (bytes.length !== artifact.size_in_bytes || `sha256:${yield* hashBytes(bytes)}` !== artifact.digest) {
            return yield* new PlanDigestMismatch({})
          }
          const receipt = yield* decodeReceipt(yield* archiveText(bytes), stack)
          const producingRun = yield* github.run(receipt.producerRunId)
          const publicationJobs = yield* github.jobs(publisher.id)
          const producingJobs = (yield* github.jobs(producingRun.id)).filter((job) => job.name === `${stack} / native`)
          const producingJob = producingJobs[0]
          const producingSteps = producingJob?.steps.filter((step) => step.name === "Native read-only plan") ?? []
          const producingStep = producingSteps[0]
          if (
            receipt.runId !== publisher.id || receipt.base !== publisher.head_sha || receipt.head !== head ||
            receipt.native.stage !== stageFor(stack) ||
            !privateRunMatches(producingRun, producerWorkflow.id, "infra.yml", "pull_request") ||
            producingRun.head_sha !== receipt.head || producingRun.status !== "completed" ||
            producingRun.conclusion !== "success" ||
            producingJobs.length !== 1 || producingJob === undefined ||
            producingJob.run_attempt !== producingRun.run_attempt || producingJob.status !== "completed" ||
            producingJob.conclusion !== "success" || producingSteps.length !== 1 || producingStep === undefined ||
            producingStep.status !== "completed" || producingStep.conclusion !== "success" ||
            producingStep.started_at === undefined || producingStep.started_at === null ||
            producingRun.referenced_workflows?.some((workflow) =>
                [
                  "knpkv/infra/.github/workflows/_infra-plan.yml@main",
                  "knpkv/infra/.github/workflows/_infra-plan.yml@refs/heads/main"
                ].includes(workflow.path) && workflow.ref === "refs/heads/main" && workflow.sha === receipt.base
              ) !== true ||
            !producingRun.pull_requests.some((pr) =>
              pr.number === receipt.pr && pr.head.sha === receipt.head && pr.base.sha === receipt.base
            ) ||
            !publicationJobs.some((job) =>
              job.id === receipt.publisherJobId && job.name === `${stack} / publish` &&
              job.run_attempt === publisher.run_attempt &&
              job.status === "completed" && job.conclusion === "success"
            )
          ) {
            return yield* new PlanProvenanceInvalid({})
          }
          return { plan: project(receipt, source, yield* github.latestMainSeenByCi(), now, artifact), producingRun }
        }).pipe(
          Effect.map(({ plan, producingRun }): PlanState =>
            failed !== undefined && compareProducerRuns(failed, producingRun) < 0
              ? { _tag: "Failed", runHref: runHref(failed.id), lastPublished: { ...plan, stale: "failed" } }
              : { _tag: "Ready", plan }
          ),
          Effect.catchTags({
            PlanProvenanceInvalid: () =>
              Effect.succeed<PlanState>({ _tag: "Unverified", reason: "provenance", source }),
            PlanArchiveInvalid: () => Effect.succeed<PlanState>({ _tag: "Unverified", reason: "archive", source }),
            PlanDigestMismatch: () => Effect.succeed<PlanState>({ _tag: "Unverified", reason: "digest", source }),
            PlanReceiptInvalid: () => Effect.succeed<PlanState>({ _tag: "Unverified", reason: "receipt", source })
          })
        )
        return yield* verified
      },
      (effect) =>
        effect.pipe(
          Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(new PlanCiUnreachable({})) }),
          Effect.catchTags({
            PlanProvenanceInvalid: () =>
              Effect.succeed<PlanState>({ _tag: "Unverified", reason: "provenance", source: null }),
            PlanMetadataInvalid: () =>
              Effect.succeed<PlanState>({ _tag: "Unverified", reason: "metadata", source: null }),
            PlanCiUnreachable: () => Effect.succeed<PlanState>({ _tag: "Unreachable" }),
            PlanCiRefused: () => Effect.succeed<PlanState>({ _tag: "Refused" })
          }),
          Effect.withTracerEnabled(false)
        )
    )
    return PlanReader.of({
      read: (app, stage) => read(app, stage).pipe(Effect.provideService(Crypto.Crypto, cryptoService))
    })
  })
)

export const disconnectedLayer = Layer.succeed(
  PlanReader,
  PlanReader.of({ read: () => Effect.succeed({ _tag: "NotConnected" }) })
)

/** Dedicated read-only Actions token is optional and server-held. No host gh token discovery or client credential configuration. */
export const configuredPlanLayer = Layer.unwrap(Effect.gen(function*() {
  const token = yield* Config.option(Config.Redacted("ALCHEMY_CONSOLE_CI_TOKEN"))
  return Option.isNone(token) ? disconnectedLayer : readerLayer.pipe(Layer.provide(githubLayer(token.value)))
}))

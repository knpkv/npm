/** Server-private GitHub transport. Token and signed download URLs stay here; body limits apply before buffering. */
import { collectBounded } from "@knpkv/bounded-io"
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientResponse } from "effect/http"
import { archiveLimit } from "./archive.js"
import { Digest, Positive, Sha } from "./receipt.js"

export class PlanCiUnreachable extends Schema.TaggedError<PlanCiUnreachable>()("PlanCiUnreachable", {}) {}
export class PlanCiRefused extends Schema.TaggedError<PlanCiRefused>()("PlanCiRefused", {}) {}
export class PlanMetadataInvalid extends Schema.TaggedError<PlanMetadataInvalid>()("PlanMetadataInvalid", {}) {}
export type GithubFailure = PlanCiUnreachable | PlanCiRefused | PlanMetadataInvalid

const Timestamp = Schema.DateTimeUtcFromString
const Repository = Schema.Struct({ id: Positive })
export const Run = Schema.Struct({
  id: Positive,
  workflow_id: Positive,
  path: Schema.String,
  event: Schema.String,
  head_sha: Sha,
  head_branch: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  run_attempt: Positive,
  run_started_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
  actor: Repository,
  triggering_actor: Repository,
  referenced_workflows: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, ref: Schema.String, sha: Sha })).check(Schema.isMaxLength(10))
  ),
  repository: Repository,
  head_repository: Repository,
  pull_requests: Schema.Array(
    Schema.Struct({ number: Positive, head: Schema.Struct({ sha: Sha }), base: Schema.Struct({ sha: Sha }) })
  ).check(Schema.isMaxLength(100))
})
export type Run = typeof Run.Type
export const Artifact = Schema.Struct({
  id: Positive,
  name: Schema.String.check(Schema.isMaxLength(256)),
  size_in_bytes: Positive,
  digest: Schema.NullOr(Digest),
  expired: Schema.Boolean,
  created_at: Timestamp,
  expires_at: Timestamp,
  workflow_run: Schema.Struct({
    id: Positive,
    repository_id: Positive,
    head_repository_id: Positive,
    head_branch: Schema.String,
    head_sha: Sha
  })
})
export type Artifact = typeof Artifact.Type
export const Job = Schema.Struct({
  id: Positive,
  name: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  status: Schema.String,
  run_attempt: Positive,
  steps: Schema.Array(
    Schema.Struct({
      started_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String)
    })
  ).check(Schema.isMaxLength(1000))
})
export type Job = typeof Job.Type
const Workflow = Schema.Struct({ id: Positive, path: Schema.String, state: Schema.String })
export type Workflow = typeof Workflow.Type
const RefusalBody = Schema.fromJsonString(Schema.Struct({ message: Schema.String }))
// A 100-run page includes repository/user/commit envelopes before schema projection (~12 KiB per run).
const metadataLimit = 2 * 1024 * 1024

export class PlanGithub extends Context.Service<PlanGithub, {
  readonly workflow: (file: "infra.yml" | "infra-publish.yml") => Effect.Effect<Workflow, GithubFailure>
  readonly runs: (file: "infra.yml" | "infra-publish.yml") => Effect.Effect<ReadonlyArray<Run>, GithubFailure>
  readonly artifacts: (stack: string) => Effect.Effect<ReadonlyArray<Artifact>, GithubFailure>
  readonly run: (id: number) => Effect.Effect<Run, GithubFailure>
  readonly jobs: (id: number) => Effect.Effect<ReadonlyArray<Job>, GithubFailure>
  readonly latestMainSeenByCi: () => Effect.Effect<string | null, GithubFailure>
  readonly download: (id: number) => Effect.Effect<Uint8Array, GithubFailure>
}>()("@knpkv/alchemy-console/PlanGithub") {}

/** Disable redirects on authenticated requests. Only the validated HTTPS blob redirect is followed, without Authorization. */
export const githubLayer = (token: Redacted.Redacted<string>) =>
  Layer.effect(
    PlanGithub,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const request = Effect.fn("AlchemyConsole.planGithubRequest")(
        function*(path: string, notFound: "refused" | "unreachable") {
          const response = yield* client.get(`https://api.github.com/repos/knpkv/infra/${path}`, {
            headers: {
              authorization: `Bearer ${Redacted.value(token)}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28"
            }
          }).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", cache: "no-store" }),
            Effect.mapError(() => new PlanCiUnreachable({}))
          )
          if (response.status === 401 || (response.status === 404 && notFound === "refused")) {
            return yield* new PlanCiRefused({})
          }
          if (response.status === 403) {
            if (response.headers["x-ratelimit-remaining"] === "0" || response.headers["retry-after"] !== undefined) {
              return yield* new PlanCiUnreachable({})
            }
            const bytes = yield* collectBounded(response.stream, 8192).pipe(
              Effect.mapError(() => new PlanCiUnreachable({}))
            )
            const refusal = Option.getOrNull(Schema.decodeUnknownOption(RefusalBody)(new TextDecoder().decode(bytes)))
            if (
              refusal !== null &&
              /\b(?:API rate limit exceeded|(?:primary|secondary) rate limit)\b/iu.test(refusal.message)
            ) {
              return yield* new PlanCiUnreachable({})
            }
            return yield* new PlanCiRefused({})
          }
          if (response.status !== 200 && response.status !== 302) return yield* new PlanCiUnreachable({})
          return response
        }
      )
      const body = (response: HttpClientResponse.HttpClientResponse, limit: number) =>
        collectBounded(response.stream, limit).pipe(Effect.catchTags({
          ByteLimitExceeded: () => Effect.fail(new PlanMetadataInvalid({})),
          HttpClientError: () => Effect.fail(new PlanCiUnreachable({}))
        }))
      const json = <S extends Schema.Top>(path: string, schema: S, notFound: "refused" | "unreachable") =>
        request(path, notFound).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? body(response, metadataLimit).pipe(
                Effect.flatMap((bytes) =>
                  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)).pipe(
                    Effect.mapError(() => new PlanMetadataInvalid({}))
                  )
                )
              )
              : Effect.fail(new PlanMetadataInvalid({}))
          )
        )
      const list = <S extends Schema.Top>(
        path: string,
        field: string,
        schema: S,
        notFound: "refused" | "unreachable"
      ) =>
        Effect.gen(function*() {
          const all: Array<S["Type"]> = []
          for (let page = 1; page <= 10; page++) {
            const envelope = Schema.Struct({ [field]: Schema.Array(schema).check(Schema.isMaxLength(100)) })
            const body = yield* json(
              `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
              envelope,
              notFound
            )
            const rows = body[field]
            if (rows === undefined) return yield* new PlanMetadataInvalid({})
            for (const row of rows) all.push(row)
            if (rows.length < 100) return all
          }
          return yield* new PlanMetadataInvalid({})
        })
      return PlanGithub.of({
        workflow: (file) => json(`actions/workflows/${file}`, Workflow, "refused"),
        runs: (file) =>
          list(
            `actions/workflows/${file}/runs?event=${file === "infra.yml" ? "pull_request" : "workflow_run"}`,
            "workflow_runs",
            Run,
            "refused"
          ),
        artifacts: () => list("actions/artifacts", "artifacts", Artifact, "refused"),
        run: (id) => json(`actions/runs/${id}`, Run, "unreachable"),
        jobs: (id) => list(`actions/runs/${id}/jobs?filter=latest`, "jobs", Job, "unreachable"),
        latestMainSeenByCi: () =>
          json(
            "actions/runs?branch=main&event=push&per_page=1",
            Schema.Struct({
              workflow_runs: Schema.Array(
                Schema.Struct({
                  head_sha: Sha,
                  head_branch: Schema.Literal("main"),
                  event: Schema.Literal("push"),
                  repository: Schema.Struct({ id: Schema.Literal(1288997422) }),
                  head_repository: Schema.Struct({ id: Schema.Literal(1288997422) })
                })
              ).check(Schema.isMaxLength(1))
            }),
            "refused"
          ).pipe(Effect.map((body) => body.workflow_runs[0]?.head_sha ?? null)),
        download: Effect.fn("AlchemyConsole.downloadCiPlan")(function*(id: number) {
          const response = yield* request(`actions/artifacts/${id}/zip`, "unreachable")
          if (response.status !== 302) return yield* new PlanMetadataInvalid({})
          const location = response.headers.location
          if (location === undefined || !URL.canParse(location)) return yield* new PlanMetadataInvalid({})
          const url = new URL(location)
          if (
            url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" ||
            !(url.hostname.endsWith(".blob.core.windows.net") || url.hostname === "objects.githubusercontent.com")
          ) {
            return yield* new PlanMetadataInvalid({})
          }
          const blob = yield* client.get(location).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", cache: "no-store" }),
            Effect.mapError(() => new PlanCiUnreachable({}))
          )
          if (blob.status !== 200) return yield* new PlanCiUnreachable({})
          return yield* body(blob, archiveLimit - 1)
        })
      })
    })
  )

export const publishedMillis = (artifact: Artifact): number => DateTime.toEpochMillis(artifact.created_at)

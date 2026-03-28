/**
 * Timer `log` command — add activity manually.
 *
 * @module
 */
import { Args, Command, Options } from "@effect/cli"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { JiraApiClient, toEffect } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import { Console, Effect, Option, Redacted } from "effect"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"

export const log = Command.make(
  "log",
  {
    key: Args.text({ name: "key" }),
    time: Options.text("time").pipe(Options.withAlias("t"), Options.withDescription("Duration (e.g. 1h30m, 2h, 45m)")),
    date: Options.text("date").pipe(
      Options.withAlias("d"),
      Options.withDescription("Date (YYYY-MM-DD, default today)"),
      Options.optional
    ),
    comment: Options.text("comment").pipe(
      Options.withAlias("c"),
      Options.withDescription("Worklog comment"),
      Options.optional
    )
  },
  ({ comment, date, key, time }) =>
    Effect.gen(function*() {
      // Parse duration string like "1h30m", "2h", "45m"
      const durationMatch = time.match(/(?:(\d+)h)?(?:(\d+)m)?/)
      if (!durationMatch || (!durationMatch[1] && !durationMatch[2])) {
        yield* Console.log("Invalid duration. Use format: 1h30m, 2h, 45m")
        return
      }
      const hours = parseInt(durationMatch[1] ?? "0", 10)
      const minutes = parseInt(durationMatch[2] ?? "0", 10)
      const totalSeconds = Math.max(60, hours * 3600 + minutes * 60)

      // Parse date
      const dateStr = Option.isSome(date) ? date.value : new Date().toISOString().slice(0, 10)
      const started = new Date(`${dateStr}T09:00:00.000Z`)
      if (isNaN(started.getTime())) {
        yield* Console.log("Invalid date. Use format: YYYY-MM-DD")
        return
      }

      // Validate ticket exists
      const jira = yield* JiraApiClient
      const issue = yield* toEffect(jira.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
        params: {
          path: { issueIdOrKey: key },
          query: { fields: ["summary", "issuetype", "labels"] }
        }
      })).pipe(
        Effect.catchAll(() => Effect.succeed(null))
      )
      if (!issue) {
        yield* Console.log(`Ticket ${key} not found in Jira.`)
        return
      }
      const fields = issue.fields as Record<string, unknown> | null | undefined
      const summary = typeof fields?.["summary"] === "string" ? fields["summary"] : key

      yield* Console.log(`Logging: ${key} — ${summary}`)
      yield* Console.log(`  Duration: ${hours}h ${minutes}m (${totalSeconds}s)`)
      yield* Console.log(`  Date: ${dateStr}`)

      // Create Clockify entry (completed)
      const clockifyAuth = yield* ClockifyAuth
      const clockifyClient = yield* ClockifyApiClient
      const auth = yield* clockifyAuth.getConfig.pipe(Effect.catchAll(() => Effect.succeed(null)))

      let clockifyOk = false
      if (auth) {
        const end = new Date(started.getTime() + totalSeconds * 1000)
        yield* clockifyClient.createTimeEntry(auth.workspaceId, {
          description: `[${key}] ${summary}`,
          start: started.toISOString(),
          end: end.toISOString()
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              clockifyOk = true
            })
          ),
          Effect.catchAll(() => Effect.void)
        )
      }

      // Create Jira worklog via raw HTTP
      const jiraAuthSvc = yield* JiraAuth
      const accessToken = yield* jiraAuthSvc.getAccessToken().pipe(
        Effect.map((t) => Redacted.value(t)),
        Effect.catchAll(() => Effect.succeed(""))
      )
      const cloudId = yield* jiraAuthSvc.getCloudId().pipe(Effect.catchAll(() => Effect.succeed("")))

      let jiraOk = false
      if (accessToken && cloudId) {
        const httpClient = yield* HttpClient.HttpClient
        const commentText = Option.isSome(comment) ? comment.value : undefined
        const response = yield* httpClient.execute(
          HttpClientRequest.post(
            `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${key}/worklog`
          ).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.bodyUnsafeJson({
              started: started.toISOString().replace("Z", "+0000"),
              timeSpentSeconds: totalSeconds,
              ...(commentText ?
                {
                  comment: {
                    type: "doc",
                    version: 1,
                    content: [{ type: "paragraph", content: [{ type: "text", text: commentText }] }]
                  }
                } :
                {})
            })
          )
        ).pipe(Effect.catchAll(() => Effect.succeed(null)))

        if (response && response.status >= 200 && response.status < 300) {
          jiraOk = true
        }
      }

      yield* Console.log(`  Clockify: ${clockifyOk ? "✓" : "✗"}`)
      yield* Console.log(`  Jira worklog: ${jiraOk ? "✓" : "✗"}`)
    })
)

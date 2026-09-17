/**
 * `@knpkv/jira-clockify` — the headless engine behind `jcf`.
 *
 * Namespace re-exports for clean imports.
 *
 * **What is here, and what is not**
 *
 * Everything a *second* surface needs to derive Proposed Worklogs and write a confirmed one: the
 * pure agent-session core, the services, the live layer composition, the write path, and the
 * calendar. Deliberately absent are the command definitions and the TUI — a consumer builds its own
 * surface, and importing `effect/unstable/cli` or `@opentui/react` to reach a service would be a
 * cost paid for nothing. The test seam lives at `@knpkv/jira-clockify/testing.js`, out of this
 * barrel so nothing production imports it by accident.
 *
 * @example
 * ```typescript
 * import { AgentWrite, Layers, ReconcileService, Time } from "@knpkv/jira-clockify"
 *
 * const week = Time.isoWeekPeriod(new Date())
 * const report = yield* (yield* ReconcileService.ReconcileService).proposeFromSessions(week)
 * ```
 *
 * @module
 */
export * as AgentSessions from "./agent/sessions.js"
export * as AgentWatch from "./agent/watch.js"
export * as AgentWrite from "./cli/agentWrite.js"
export * as Calendar from "./cli/calendar.js"
export * as FetchTicket from "./cli/fetchTicket.js"
export * as Layers from "./cli/layers.js"
export * as AgentSessionReader from "./services/AgentSessionReader.js"
export * as ClockifyAuth from "./services/ClockifyAuth.js"
export * as ConfigService from "./services/ConfigService.js"
export * as HomeDirectory from "./services/HomeDirectory.js"
export * as IssueFacts from "./services/IssueFacts.js"
export * as ReconcileService from "./services/ReconcileService.js"
export * as SavedEntries from "./services/SavedEntries.js"
export * as SessionAttributor from "./services/SessionAttributor.js"
export * as StateWriter from "./services/StateWriter.js"
export * as TicketService from "./services/TicketService.js"
export * as TimerService from "./services/TimerService.js"
export * as Time from "./utils/time.js"

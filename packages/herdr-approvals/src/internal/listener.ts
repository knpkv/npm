/**
 * The kinds of listener the host HTTP server runs, and what each serves.
 *
 * @module
 */
export type ListenerMode = "local" | "tailnet" | "approval" | "serve" | "work" | "lan"

/** Which listeners serve `GET /v1/work`; the dashboard is told, so it polls only what exists. */
export const listenerServesWork = (mode: ListenerMode, crossHost: boolean): boolean =>
  mode === "serve" || mode === "work" || (mode === "local" && !crossHost)

/**
 * The kinds of listener the host HTTP server runs, and what each serves.
 *
 * @module
 */
export type ListenerMode = "local" | "tailnet" | "approval" | "serve" | "work" | "lan"

/** Which listeners serve `GET /v1/work`; the dashboard is told, so it polls only what exists. */
export const listenerServesWork = (mode: ListenerMode, crossHost: boolean): boolean =>
  mode === "serve" || mode === "work" || (mode === "local" && !crossHost)

/**
 * Which listeners serve the super-app: every host's loopback, plus the notification hub's tailnet TLS
 * listener. Tailnet, approval, work and LAN listeners never do.
 */
export const listenerServesSuperapp = (mode: ListenerMode): boolean => mode === "serve" || mode === "local"

/**
 * Whether a listener answers for the whole fleet (peer agents, usage, limits) rather than this host.
 * Only the notification hub aggregates, because peers' per-host routes admit the hub's node alone; its
 * loopback shows the same fleet as its tailnet listener.
 */
export const listenerAggregatesFleet = (mode: ListenerMode, isHub: boolean): boolean =>
  mode === "serve" || (mode === "local" && isHub)

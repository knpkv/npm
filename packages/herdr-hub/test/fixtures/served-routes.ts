/**
 * One request for every route family the hub serves, with the family it names. The route-family test reads
 * it as the table, and the access gate's walker asks each family whether a caller without a session gets in.
 * A new family goes here, so both see it.
 */
export const servedRoutes: ReadonlyArray<readonly [method: string, pathname: string, family: string]> = [
  ["GET", "/assets/index.css", "static"],
  ["GET", "/manifest.webmanifest", "static"],
  ["GET", "/", "page"],
  ["GET", "/connect/", "page"],
  ["GET", "/v1/dashboard", "dashboard"],
  ["GET", "/v1/jobs/job-1", "dashboard"],
  ["POST", "/v1/jobs", "jobs.submit"],
  ["POST", "/v1/jobs/job-1/approve", "jobs.decide"],
  ["POST", "/v1/jobs/job-1/reject", "jobs.decide"],
  ["GET", "/v1/work/recovery-context", "work.read"],
  ["POST", "/v1/work/pull-request-link", "work.write"],
  ["GET", "/v1/push/config", "push.read"],
  ["POST", "/v1/push/subscriptions", "push.write"],
  ["GET", "/v1/connect/agents/local", "connect.service"],
  ["GET", "/v1/connect/terminal", "connect.service"],
  ["GET", "/v1/connect/session", "connect.terminal"],
  ["POST", "/v1/connect/posts", "connect.report"],
  ["POST", "/v1/connect/me", "connect.report"],
  ["GET", "/v1/connect/posts", "connect.read"],
  ["GET", "/v1/host/resources", "connect.read"],
  ["GET", "/v1/modules/sandboxes/overview", "modules.read"],
  ["POST", "/v1/modules/sandboxes/jobs", "modules.sandboxes"],
  ["POST", "/v1/modules/code/review", "modules.write"],
  ["POST", "/v1/modules/fleet/failures/dismiss", "fleet.failures.dismiss"],
  ["POST", "/v1/modules/fleet/failures/retry", "fleet.failures.retry"],
  ["GET", "/v1/apps", "apps.read"],
  ["GET", "/apps/notes/", "apps.read"],
  ["POST", "/v1/apps/notes/restart", "apps.restart"],
  ["POST", "/apps/notes/save", "apps.write"],
  ["GET", "/v1/app-services/fleet/read", "app-services"],
  ["POST", "/v1/relay/decisions", "relay.decide"],
  ["GET", "/v1/relay/events", "relay.read"],
  ["POST", "/v1/relay/messages", "relay.write"],
  ["GET", "/v1/session", "session"],
  ["POST", "/v1/session/tailscale", "session"]
]

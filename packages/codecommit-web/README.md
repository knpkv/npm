# CodeCommit web pairing boundary

CodeCommit web owns an ephemeral, process-scoped owner session. Each bind rotates
the owner, CSRF, and bootstrap credentials; the bootstrap credential is valid for
60 seconds, single-use, and limited to five failed unauthenticated attempts. The
owner cookie is HttpOnly and SameSite=Strict. This intentionally differs from
Control Center's durable workspace session (12-hour idle and 30-day absolute
lifetimes). The policy is the shared single-operator Owner Session from
`@knpkv/browser-pairing/owner-session` (ADR-0008); CodeCommit web keeps its API
middleware, wire errors, `cc_owner` cookie name, and dev-proxy model.

Origin checks use the configured loopback authority captured at bind time. The
request `Host` header is not an authority source. Browser reads that Fetch
Metadata marks as cross-site, or as same-site/`none` without the bound Origin,
are refused; explicit clients without Fetch Metadata still need the owner
cookie.

The authenticated event stream carries `callerIdentities`, the caller's identity
per configured account and keyed by AWS profile. Each entry is either `Resolved`
(`accountId`, `arn`, `username`) or `Unresolved` with a typed `reason`
(`CredentialsUnavailable`, `StsRejected`, `Throttled`, `RefreshAuthFailed`, or
`SignedOut` after `aws sso logout` until the next refresh resolves the account again; that
includes accounts whose credentials are not SSO). It gives the client what it needs to match wildcard approval pools (`…/Reviewers/*`)
against the exact `arn` of the account a pull request lives in. That ARN is a client-visible identifier:
for SSO sessions its last segment is usually the person's email. It travels only
to the owner it describes, over the owner-cookie-authenticated stream. It is never
logged, never served on unauthenticated routes, and the browser keeps it only in
its in-memory snapshot. Reasons carry no provider message; the account's
notification explains the failure.

## Relay routes

`/api/relay` serves the Relay assistant dock, behind the same owner cookie and CSRF policy as every
other route. A session is keyed by a `RelayRef` (`{ product: "codecommit", kind, id }`). For a pull
request the `id` is `accountId/region/repositoryName/pullRequestId`. That is a client-visible
identifier: it crosses authenticated HTTP and the event stream, and it is never served on
unauthenticated routes. Profiles, credentials and provider ARNs never cross into it.

- `GET /events?product&kind&id`: server-sent events, a `Snapshot` first, then `RelayEvent` frames.
  Every 15 seconds `: hb` re-checks the owner session. Once the session no longer holds, the stream
  sends `data: {"_tag":"Unauthorized"}` and ends.
- `POST /messages {ref, text, requestId, backend?}`: 202 `{runId}`, the `requestId` that the run's
  events list in `runIds`. An unknown `backend` is 400.
- `POST /cancel {ref, runId}` and `POST /decisions {ref, callId, allow}`: 204, or 409 with the state
  found: `NotRunning`, `Decided {allow}`, `Expired` or `Unknown`.
- `GET /session?product&kind&id`: the session's tools, its current backend, and `cancel` (offer Stop
  only when true). A posted comment's `ToolFinished.receipt` carries CodeCommit's operation id and the
  pull request's console link.
  `GET /backends`: `Unverified`, `Ready` or `Unavailable` with a one-line fix.

Sessions hold conversation content. They live in `~/.codecommit/relay/sessions.sqlite`, with an
owner-only directory (`0700`) and database (`0600`). One server process owns them. A second
`codecommit web` on the same home keeps serving the queue, and answers 503 `RelayUnavailableError`
with the fix on `/api/relay`. Turns run on the user's own Claude Code or Codex CLI login, with every
CLI tool withheld. Relay's `post_comment` posts through the same permission rules, prompt and audit
log as review findings (`postPullRequestComment`, IAM `codecommit:PostCommentForPullRequest`).

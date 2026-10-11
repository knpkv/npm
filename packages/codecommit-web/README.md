# CodeCommit web

The browser view of the CodeCommit review queue: pull requests that need a decision, their diffs and
approvers, Relay reviews, and sandboxes.

## Browser views

Import presentation components and their props from `@knpkv/codecommit-web/views`, and load
`@knpkv/codecommit-web/views/style.css` once. The browser entry excludes the application's atoms,
owner-session bootstrap, and server entry. React, React DOM, React Router, and Rly are optional
peers; browser consumers supply them and the router/provider contexts their views use.

`SettingsSandboxView` requires `renderConfigUnavailable`. Preview callers can render
`ConfigUnavailableView` with an explicit `path`, `connectionDetail`, and `onRetry`; the application
container supplies its existing authenticated failure panel. A non-null `connectionDetail` means
the owner session is unavailable. Only supply a config path obtained through the authenticated API;
never put provider credentials or server-private locators in preview fixtures.

## Start it

You need [Bun](https://bun.sh) 1.3 or later and an AWS CLI profile that can read CodeCommit.

1. Create a profile if you don't have one: `aws configure sso` (or `aws configure --profile NAME` for keys).
   Profiles are read from `~/.aws/config` and `~/.aws/credentials`, or from `AWS_CONFIG_FILE` and
   `AWS_SHARED_CREDENTIALS_FILE` when those are set. The app never edits these files.
2. Run `codecommit web`. It prints one sign-in link and opens it; the link works once, within 60 seconds.
   Lost it? Run the command again: it reuses the running server, opens a fresh link and exits.
   `codecommit web login` prints one without opening. `--no-open` suppresses opening on the root.
   If no server answers, the command starts one in the foreground until SIGINT/SIGTERM;
   closing the tab never stops it. A refused login fails instead of starting another server.
3. The first screen says what's missing, if anything: "No AWS profiles yet" links to Settings → Accounts,
   which shows where it looked, the commands that create a profile, and "Detect again".

Settings live in `~/.codecommit/config.json`. Until the first setting is saved there is no file and the
defaults apply.

### Supervised owner process

A deployment can keep the credential host's owner process running with
`bun packages/codecommit-web/dist/main.js`, built from the same revision as hostd and its
workspace dependencies. This entry stays running; `codecommit web` instead reuses a running
owner and exits after requesting a sign-in link. The process needs Bun and its child commands
on `PATH`. `PORT` chooses the first loopback port; the standalone entry retains its port retries.
Do not set the development proxy's `CODECOMMIT_WEB_PUBLIC_ORIGIN` or `ALLOWED_ORIGINS` for this service.

For a systemd user service, use `Restart=on-failure` and `StandardOutput=null`: the startup
sign-in URL contains a single-use credential and must not reach the journal. Operational stderr
may go to the journal. The owner-only control file records the actually bound origin, so
`codecommit web` can obtain a fresh link even after a port retry.

Only the owner process creates, repairs and migrates its cache and runs its configured refresh
policy. Its permission gates stay in force. The hub verifies an existing private cache with the
exact supported schema; it never creates, repairs, migrates or chmods that cache. An unreadable
cache remains Unavailable. Check the owner service and the hub's private diagnostic log;
the hub's existing poll or Read again retries attachment without restarting the hub.

## AWS calls ask first

Every AWS call is gated. A fresh install asks before each one (`~/.codecommit/permissions.json` starts
empty). Reads (listing pull requests, approval status, your identity) ask in a bar at the top of the page,
where "Allow every read" grants the whole read category in one saved step. Writes (creating pull requests,
posting comments, changing approval rules) ask in a dialog with "Allow once" as the default; "Always
allow" there covers only that one operation. Settings → Permissions shows and resets every grant.

The host-local Code read factory in `./host/server` uses saved `always_allow` grants only.
It rereads the saved policy before every provider call. Missing, unreadable or corrupt policy
returns `permission_required`; a would-ask read opens no prompt and changes no grants.
Unreadable policy is logged with its authenticated caller and private diagnostic cause.
Explicit denial stays denied. Granting and all writes remain in the paired owner UI.

These host reads always append an authenticated-caller audit before contacting the provider,
even when the owner UI's optional audit setting is off. A failed append refuses the call.
The duration entry follows the read. The provider is constructed once; the caller wrapper is
request-specific. Cache attachment is lazy, requires the existing owner's exact schema and
private permissions, and retries a failed attachment after two seconds without migrating it.

`./host` carries browser-safe read contracts. Queue summaries include the opaque reference,
PR id, repository display name, title, derived author display, status, cached approval state
and observation times. Detail adds bounded description and branch names; immutable diffs add
in-repository paths, revisions and bounded text. Render user-authored content as text.
Provider account identifiers, ARNs used as author metadata, profile names, regions, credentials,
cache paths and original error causes remain server-private. Content is served only by the
credential host's own authenticated hub; it must not be proxied through peer or fleet reads or
the hub's Relay context. Queue visibility rereads persisted enabled accounts; an exact opaque
target still resolves when its account is hidden. Unknown references return 404.

`./views` exports the controlled `CodeHostView`; import `./host/style.css` beside the
application's Rly stylesheet. The optional `onOpenReference` callback lets the host push
deliberate target navigation. Without it, target links use ordinary browser navigation;
modified clicks always retain that behavior. Selection, read state and refresh remain host-owned.
The workspace `@knpkv/codecommit-web/views` type entry uses built declarations so hub consumers
do not traverse the owner view source aliases. Build this package before typechecking the hub.
Build and prepack force declaration emission even when `dist` was cleared with build-info retained.
Removing those source aliases is a follow-up; published type, runtime and CSS paths are unchanged.

The hub queue may add `ownerUi`, the validated direct HTTP loopback origin read afresh from the
owner control file. It is a normalized authenticated client-visible origin, with no credential,
path, query or fragment. The control file and its bearer token stay server-private and owner-only;
neither enters the queue response or logs. Missing, linked, permissive or malformed files omit
the field; there is no default-port fallback. The browser shows the link only when viewing the
hub on this machine. Other devices receive the existing credential-host instructions.

## Pairing boundary

CodeCommit web owns an ephemeral, process-scoped owner session. Each bind rotates
the owner, CSRF, and bootstrap credentials; the bootstrap credential is valid for
60 seconds, single-use, and limited to five failed unauthenticated attempts. The
owner cookie is HttpOnly and SameSite=Strict. This intentionally differs from
Control Center's durable workspace session (12-hour idle and 30-day absolute
lifetimes). The policy is the shared single-operator Owner Session from
`@knpkv/browser-pairing/owner-session`; CodeCommit web keeps its API
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

## Owner control route

After its authenticated listener is ready, each server publishes `~/.codecommit/web.json`:
`{origin, token}` stores the direct loopback origin actually bound, including a port retry, and a
server-private bearer credential rotated on every bind attempt. The directory is `0700`, the file
`0600`, and linked or permissive paths are refused. Publication is atomic under an exclusive lock;
shutdown removes only the file holding this server's token, leaving a newer server's file intact.

`POST /control/login` requires that bearer token, independently of cookies and CORS. No or wrong
bearer returns 401 without minting. Success returns an uncached `{url}` whose one-time bootstrap
code uses the same public origin, exchange, single-use policy and expiry as startup. A dev proxy
therefore receives the same kind of link as startup. Control tokens and the file are owner-only and
server-private, never browser/API projections or log fields. The returned URL is credential-bearing;
the CLI prints it on stdout and passes it to the opener, never to logs. CLI web logs go to stderr.
Standalone `serveCodeCommit` retains its ready block by default; an `announce` callback replaces
that stdout block. `onReady` still runs after announcement.

## Relay routes

`/api/relay` serves the Relay assistant dock, behind the same owner cookie and CSRF policy as every
other route. A session is keyed by a `RelayRef` (`{ product: "codecommit", kind, id }`). For a pull
request the `id` is `accountId/region/repositoryName/pullRequestId`. That is a client-visible
identifier: it crosses authenticated HTTP and the event stream, and it is never served on
unauthenticated routes. Profiles, credentials and provider ARNs never cross into it.

- `GET /events?product&kind&id`: server-sent events, a `Snapshot` first, then `RelayEvent` frames.
  Every 15 seconds `: hb` re-checks the owner session. Once the session no longer holds, the stream
  sends `data: {"_tag":"Unauthorized"}` and ends. If Relay can't read the session's events, the stream
  sends `data: {"_tag":"StreamFailed"}` and ends, so the dock can tell Relay failing from a dropped
  connection. The cause stays in the server log.
- `POST /messages {ref, text, requestId, backend?, context?}`: 202 `{runId}`, the `requestId` that the
  run's events list in `runIds`. An unknown `backend` is 400. `context` holds at most one
  `ReviewFindings { reviewedHead, findings }`: the findings the person is looking at. Findings live in
  the browser's review session, not on the server. Relay is told which head they were reviewed at, so it
  can say when they come from an older head.
- `POST /cancel {ref, runId}` and `POST /decisions {ref, callId, allow}`: 204, or 409 with the state
  found: `NotRunning`, `Decided {allow}`, `Expired` or `Unknown`.
- `GET /session?product&kind&id`: the session's tools, its current backend, and `cancel` (offer Stop
  only when true). A posted comment's `ToolFinished.receipt` carries CodeCommit's operation id and the
  pull request's console link.
  `GET /backends`: `Unverified`, `Ready` or `Unavailable` with a one-line fix.

Sessions hold conversation content. They live in `~/.codecommit/relay/sessions.sqlite`, with an
owner-only directory (`0700`) and database (`0600`). One server process owns them. `codecommit web` reuses the server already holding that home. Starting another standalone
server on the same home still serves the queue, but answers 503 `RelayUnavailableError`
with the fix on `/api/relay`. Turns run on the user's own Claude Code or Codex CLI login, with every
CLI tool withheld.

Relay's tools here:

- `get_pull_request`, `list_pull_requests`: from the local cache.
- `get_pull_request_diff`: the changed files at the current revision, with that revision's ids.
- `post_comment`: a top-level comment.
- `post_line_comment`: one line, on the before or after side, pinned to the revision it was written
  against. It is refused with `ReviewHeadMoved` if the pull request has moved since, and with
  `CommentLineOutsidePatch` if the line is outside the changes, so it never lands on a different line.

Both comment tools post through the same permission rules, prompt and audit log as review findings
(`postPullRequestComment`). IAM: `codecommit:PostCommentForPullRequest`. The diff and line comments also
read `codecommit:GetPullRequest`, `codecommit:GetDifferences` and `codecommit:GetBlob`, as the review
workbench does.

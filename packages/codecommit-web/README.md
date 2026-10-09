# CodeCommit web

The browser view of the CodeCommit review queue: pull requests that need a decision, their diffs and
approvers, Relay reviews, and sandboxes.

## Start it

You need [Bun](https://bun.sh) 1.3 or later and an AWS CLI profile that can read CodeCommit.

1. Create a profile if you don't have one: `aws configure sso` (or `aws configure --profile NAME` for keys).
   Profiles are read from `~/.aws/config` and `~/.aws/credentials`, or from `AWS_CONFIG_FILE` and
   `AWS_SHARED_CREDENTIALS_FILE` when those are set. The app never edits these files.
2. Run `codecommit web`. It prints one sign-in link and opens it; the link works once, within 60 seconds.
   Lost it? Run the command again for a new one.
3. The first screen says what's missing, if anything: "No AWS profiles yet" links to Settings → Accounts,
   which shows where it looked, the commands that create a profile, and "Detect again".

Settings live in `~/.codecommit/config.json`. Until the first setting is saved there is no file and the
defaults apply.

## AWS calls ask first

Every AWS call is gated. A fresh install asks before each one (`~/.codecommit/permissions.json` starts
empty). Reads (listing pull requests, approval status, your identity) ask in a bar at the top of the page,
where "Allow every read" grants the whole read category in one saved step. Writes (creating pull requests,
posting comments, changing approval rules) ask in a dialog with "Allow once" as the default; "Always
allow" there covers only that one operation. Settings → Permissions shows and resets every grant.

## Pairing boundary

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
owner-only directory (`0700`) and database (`0600`). One server process owns them. A second
`codecommit web` on the same home keeps serving the queue, and answers 503 `RelayUnavailableError`
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

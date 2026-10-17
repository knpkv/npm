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

The host review reader uses those same saved read grants and audits to load the current immutable
diff. It then reads the completed owner review record and the existing CodeCommit comment cache;
it never starts a review, fetches provider comments, creates the cache or exposes a writer. Checks
remain unknown without a checks source, and Slack is not read by this adapter. Comment capture time
is retained independently of message creation time. Missing, oversized and corrupt comments have
distinct reported states; none is an empty conversation.
`@knpkv/review` is a runtime dependency for these persisted and host contracts. Its server-imported
entry contains schemas and pure transitions; the review React views remain separate entries.

The host canvas reader (`CodeHostReads.canvas`) reads every changed file of the current revision through
the same saved read grants and audits, one file at a time in the background, and answers `Building` with
the files read so far until the graph is ready. TypeScript and JavaScript files get import edges resolved
only between files of the change, and their changed top-level declarations; other languages are
recorded as having no dependency data. Call edges, moves, partitions and the review context
(last look, reading path, finding history, failing tests) are `NotRecorded` until their readers exist.
Paths are the change's repository-relative diff paths; no provider locator crosses the boundary.

Owner review endpoints persist completed output in version-1 JSON records under the private review
directory. The hashed storage key comprises namespace and a server-private subject tuple of caller
account identity, region, repository and PR ID. Profile labels are excluded, so a rename does not
lose history. Missing account identity refuses persistence explicitly. The record retains reviewed revision, base
and head plus execution profile, verdict, findings and Explain text. No raw provider credential is
a record field. Atomic owner replacements are capped at 1 MiB; missing records are absent and corrupt
records have an unavailable state independent of the diff and comments. A later completed owner
review replaces corrupt or oversized history; I/O and private-path refusals remain failures.
Completed results survive save failures with a typed `historyWarning`; streams carry it on their
complete frame. Reads refuse symlinked paths or directory/file modes other than 0700/0600, and
files must belong to the directory owner. This path check uses the Effect filesystem service;
it does not claim the database adapter's descriptor-pinned race protection.
The host imports a separate reader module, rebinds the private subject to
the authenticated client-visible opaque reference, and preserves the original reviewed revision.
Stored subject tuples, paths and provider coordinates never cross HTTP.

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
The product reader delegates private-path verification and origin-only projection to
`makeWebControl.readOrigin`, then applies the stricter Code owner-origin schema. It never
uses the credential-bearing login reader to produce this metadata.

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

The shared `@knpkv/browser-pairing/control` protocol owns file locking and the bearer login route.
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

### Review controller focus

Before a review controller disables its focused activation control or replaces focused findings with progress, it moves focus to the retained, named review pane. Focus outside that pane stays with its current owner. The pane stays focused through completion; Escape closes only the open findings drawer and restores its opener. The same rule applies to the controlled P2 review workspace.

### Read-only review history states

`ReviewRunFallbackView` from `./views` renders export 66's read-only `No agent review yet` or `Review history unavailable` panel. Pass only a `NotRecorded` or `Unavailable` history reading; render a ready run through the review summary and findings instead. Pass a `readAgain` pair containing `onReadAgain` and `focusTarget`, or null for a message-only notice. `onReadAgain` re-reads history and never starts a review. Before calling it, the button focuses the current target returned by the required `focusTarget` callback. Supply a focusable host container or heading that stays mounted across NotRecorded, Unavailable and Ready. A null, detached or non-focusable target leaves focus on the button and still starts the read. Test the host’s actual target for tabIndex=-1, visibility and focus before installing the view. A failed re-read leaves focus on that host container; the host owns loading/completion announcements. The host keeps the PR header, checks, diff and human comments available around this panel. No verdict, run metadata or agent command is inferred from missing history. Pass the independent conversations reading too: the notice names available comments only for Ready conversations; unreadable or uncached comments use the diff-only sentence. Failure reasons remain typed data and are not printed into the notice.

`ReviewThreadsFallbackView` renders export 64's comments-cache or typed thread-conflict notice in either the Threads or Conversation slot. Reasons use their own words, and no counts, rows, reply fields or agent actions are inferred. It shares the same Read again focus handoff as the history panel. `ReviewWorkspaceNotices` composes export 66 with one retry per host read. When comments are unavailable or thread identities conflict, the history notice is message-only and Threads owns Read again. Conversation keeps unreadable history message-only and puts the single retry in its discussion feed, or in its comments/conflict notice when that read is also unavailable. Known absent history adds no Conversation notice or action. Recorded summary and diff remain with their read views; a conflict replaces the list, not the recorded verdict.

`useCodeReviewReading` is the host-independent read controller. Supply a host-owned read callback and enable it only while its owner is active and visible. Callback identity changes do not restart an in-flight read; the next explicit read uses the latest callback. It performs one read on selection or reactivation, has no poll, and interrupts on hide, target change or unmount. Read again is a no-op while a read is in flight. A target switch immediately hides the previous target's value; late results are rejected by reference and request identity. Same-target recoverable failures return explicit `Retained` output, while unauthorized/not-found failures drop it. Views must frame Retained/Loading.previous as previous readings. Closed failures expose safe reason codes or Unexpected, never raw causes. The controller does not import the owner API or grant command authority.

### Controlled review reads

`useCodeReviewReading` takes an opaque ref, an enabled flag and a host-owned read callback. It performs one read on selection, explicit Read again or reactivation; it never polls. Read again during an in-flight request is a no-op. Inactivation interrupts the request and shows Paused with the same-ref previous value; reactivation shows Loading with that value and reads once. A ref switch immediately drops the other ref's value. Callback identity changes never interrupt or restart a read; the next explicit request uses the latest callback. Completion must match both the ref and the request id.

Ready is current. Retained carries both the previous value and a closed failure, so render it with previous-reading words. Authorization loss and not-found drop the protected value. Expected failures expose only the closed reason codes; defects become Unexpected, without transport details. The host view owns loading/completion announcements and the retained focus target.

`ReviewSummaryView` renders the recorded verdict verbatim as neutral prose, separate from severity counts and approval metadata. Typed thread conflict hides counts while retaining the verdict and provenance. Explain output stays visible without an empty finding count. Missing legacy axes, patches and risks remain absent. The profile name, harness label, model and review kind come from the recorded execution profile; no agent identity or avatar is inferred. The visible reading time is HH:MM in the viewer zone, with the full date on the time element. Pass only a validated `DateTime.TimeZone.Named`; the host parses settings once with `DateTime.zoneMakeNamed` and handles None as invalid settings. Omission uses the browser zone; invalid strings cannot be passed as this option.

`ReviewFindingCard` is read-only. Pass the same unique workspace/presentation `scope` as its index; the card target uses `reviewThreadElementId(scope, thread)`. A separate recorded title stays the claim; Why preserves the short summary and longer details, without duplicate paragraphs. Recommendation and How to verify remain prose. A suggested patch renders only when actually recorded, with its path and immutable head beside it. Recorded dispositions and resolved threads render as plain text; dismissed reasons and notes are preserved, with no invented actor or time. A recorded Requirement uses the same prose labels. The card has no execution, approval, reply or disposition controls.

`ReviewFindingsIndexView` consumes the existing primary/secondary projection without reclassifying findings. P0/P1 links precede the controlled P2-P4 group. The retained toggle names how many findings it hides; collapsed links live under a hidden region, with matching aria-controls/aria-expanded. Secondary-only output keeps its Findings heading; both-empty output renders nothing, leaving clean/missing/unavailable wording to the parent. Omitting `threads` preserves this findings-only index. Passing `threads` adds the recorded discussion rows and All, Findings and Comments filters. Counts render only for an Exact total; incomplete snapshots omit them. These filters change index rows only, leaving cards and diff targets available. The host resets the scope for a different subject.

The host supplies `hrefForThread` and the controlled secondary pair. Index and cards share one unique workspace/presentation scope and `reviewThreadElementId`, which encodes the complete scope/source/id tuple as a selector-safe target. For a direct or history link into secondary findings, the host must expand the group before focusing the card. An optional `onOpenThread` handles deliberate selection; modified clicks keep native link navigation. Hub hrefs must preserve the shell's module hash route and use owner selectors rather than replacing it with a card fragment. Recorded status words are shared with the card; the index adds no write/review controls.

`ReviewThreadMessagesView` renders recorded author, time and body in input order. Live bodies reuse the shipped sanitized Markdown renderer. A deleted message keeps its author/time but replaces the body with plain secondary-ink “Comment deleted”; its retained text never enters Markdown, and live replies stay below it. Empty messages render nothing. There is no inferred avatar, placeholder slot, reply box or action. The view takes the same validated named viewer zone as the summary; HH:MM has full date/time metadata.

`ReviewDifferentRevisionView` accepts only the DifferentRevision projection, using the shared caution notice. It makes no ancestry claim and adds the recorded/current head sentence only when those heads differ. Base/revision-only mismatches keep the universal text; their identities remain available for metadata. The findings-placement sentence is omitted when the run records no finding threads, including clean and Explain output. The host must show these findings separately from current diff lines. This read-only view has no Review again or write action.

`ReviewWorkspaceView` composes the recorded Review or Conversation body. The host keeps the PR header, subtabs, immutable diff reads and navigation. Pass the current decoded workspace, a unique owner scope, controlled secondary expansion and the diff slot. Thread ids include owner scope, subject and presentation, so retained Review and Conversation copies do not collide. Reset secondary expansion and thread selection when the subject or revision changes. The host supplies a focus target that stays mounted across all controller states, including Loading and Failed; retries focus it before reading. A thread conflict preserves verdict, provenance and diff while replacing all joined rows/counts with its notice. Findings retained from a different revision are separate cards under Recorded findings. Other unplaced cards keep Not tied to a line; the heading follows the row's snapshot origin, not merely the presence of an older run. Guide remains with its existing standalone owner; the hub does not install it until a backing reader exists.

Optionally supply `parsedDiff` with the exact bounded parsed files and a required typed failure renderer. The body renders those objects through Rly `PatchDiffView`, places Current findings once across all files and keeps one separate fallback for unplaced findings. Closing secondary disclosure removes its cards and inline targets from the DOM. Identity or duplicate-file failure retains raw diff and every separate finding, alongside the host-rendered failure. DifferentRevision findings and conflicted threads never annotate current lines. Human discussions from the current comments snapshot, or from a Current run, use their exact recorded side and line. Discussions retained inside a DifferentRevision run stay separate even when their anchors match; outdated or absent anchors also remain separate. The `diff` slot remains available for host-owned inventory, loading and rejected-file content.

The bounded diff adapter parses real Git-framed output with Rly, preserving quoted paths, rename, modes and absent sides. Display budgets run before synchronous diff computation. The exported `canRenderCodeText` applies the shared 100 KiB and 2,000-line bound; the hub applies it cumulatively across its stacked reading. Current-only placement checks the complete immutable identity and actual numbered hunk records across all eligible files. Every finding is either one inline target or one global separate fallback; rejected/unread files, sparse lines, outdated and ambiguous anchors never erase a finding. The renderer must consume the same parsed objects, and the parent must show typed identity/parse failures without presenting an empty or clean diff.

`CodeHostView.reviewWorkspace` is an optional host-owned slot for the recorded body. Without it, the existing Summary/diff presentation is unchanged. On PR pages, supplying this slot renders the selected PR as a full Code page with a metadata header and no queue or dialog. The optional `reviewBeforeDetail` slot places retained-read diagnostics before PR metadata while the host keeps its stable read/focus owner in the workspace. The optional `reviewChecks` slot supplies recorded header checks; omission makes no checks claim. Pass the review owner’s typed `reviewStatus` to deduplicate matching detail loading, failure or availability messages on the full page. Distinct detail failures and refusals remain visible. Without that status, detail keeps its independent messages. The host keeps Review/Conversation subtabs absent until a workspace reading exists; retained readings keep their subtabs during a reread. Returning to the queue restores its row focus and search context. Diffs and standalone callers without this slot keep their existing presentation. The host supplies the body, read lifetime and a focus target outside loading/replaced content. `CodeReadStatusView` shares the existing closed read-failure and availability copy without exposing raw causes. Import `@knpkv/codecommit-web/views/style.css` for the library views alongside the host stylesheet.

The reader's `completion` is the accepted finished request's opaque ref and per-owner id, or null while loading, paused or on another ref. Parent renders and rejected late/aborted requests do not publish a completion. A host may key completion content by this id while keeping its live region mounted. This is UI update identity, not authorization. `CodeReadStatusView.presentation` defaults to `plain`; `panel` opts into full-page loading, failure and availability panels without changing the words or retry ownership. `CodeReadStatusView.action` is an optional host-owned slot in panel presentation. It follows the copy inside the first visible panel, once even during retained loading or failure. Plain presentation omits it. The host supplies its existing callback and persistent focus target; the view derives no retry or command authority. `CodeReadStatusView.announce` defaults to true for its inserted loading/failure statuses; false keeps those words visible while a composed host supplies one stable announcement region. Inserted statuses may announce immediately. Updates inside an existing region are a separate path; DOM mutation does not prove assistive-technology delivery.

Conversation preserves discussion order. Finding threads without messages remain only on Review; real finding discussions show a severity/claim link to that card and their recorded messages, without repeating finding evidence. A recorded verdict appears as Agent summary with the same recorded provenance/time as the summary, without an avatar or resolved state. Unresolved counts only listed discussion threads with resolved=false, excluding the Agent summary. Show it only for complete snapshots, with comments Ready and run Ready or NotRecorded; incomplete and zero counts are omitted. Human threads keep their recorded author/time/body without reply controls.

`ReviewFindingsIndexView.notice` inserts a read-only comments notice after its filters and before available rows. `ReviewThreadsFallbackView.heading` defaults to true; false lets that containing index own the sole heading and named region. Conflicts still replace the list.

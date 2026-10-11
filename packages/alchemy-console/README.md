# @knpkv/alchemy-console

Run `alchemy-console` to serve the read-only API on `127.0.0.1:3114` and open a
one-time login link. `alchemy-console login` behaves the same way: it asks an
existing server for a fresh link, or starts one in the foreground. `--no-open`
prints the link without opening a browser. CI, non-interactive stdout and
`BROWSER=none` also skip opening. `--port` selects a port from 1024 through 65535.
`alchemy-console serve` always prints only and runs until SIGINT or SIGTERM.
Closing a browser tab leaves the foreground server running.

The browser shows stacks grouped by app, with desktop columns and compact phone
rows. Read again starts a fresh discovery request and clears the previous rows.
Loading, empty, incomplete discovery and owner sign-in failures are explicit.
Missing metadata reads Unknown; zero resources remains zero. No polling, cached
rows, plan, apply or destroy runs. Stage names and known resource counts open the
stack UI. Resources lists actual returned resource metadata; State groups the
same resources by their returned construct parent and exact type. Resource rows
open identity and dependency details. Outputs distinguishes Hidden values, proven
empty state and unavailable formats. No raw JSON click target, Plan tab or Preview
changes action is present.

The standalone wrapper shows Alchemy console, the actual local listener address
and owner session status. It adds no Relay host inventory or shell navigation.

Configuration is read at startup:

| Variable               | Default                                        | Boundary                              |
| ---------------------- | ---------------------------------------------- | ------------------------------------- |
| `ALCHEMY_CONSOLE_ROOT` | `Work/dev` under the user's home               | Server-private project discovery path |
| `AWS_CONFIG_FILE`      | `.aws/config` under the user's home            | Server-private SSO configuration path |
| `ALCHEMY_CONSOLE_HOME` | `.cache/alchemy-console` under the user's home | Server-private control directory      |

Login reuse is per port. A reused server keeps its startup configuration. The
control directory must be owned by the current user with mode `0700`; each
`serve-<port>.sock` is `0600`. Symlinks, foreign owners and pre-existing stale
sockets fail explicitly. For an abandoned socket, confirm its server has stopped
before removing that entry and restarting. The control channel currently requires
POSIX ownership and Unix sockets.

## Authenticated API

The client-safe contracts are exported from `@knpkv/alchemy-console/api` and may be
used with Effect's `HttpApiClient`. Both endpoints require the process's owner
cookie, and all responses are private and uncacheable:

The cookie name includes the bound listener port, so sessions on different ports
can coexist in one browser. Both API boundaries select that listener's cookie.
Cookies still share the loopback host and travel across ports; the name separates
sessions and does not provide port confidentiality. The API middleware resolves
the name at runtime rather than declaring a fixed OpenAPI cookie scheme.

| Route                 | Result                                                 |
| --------------------- | ------------------------------------------------------ |
| `GET /api/stacks`     | Stack summaries and explicit local/S3 discovery issues |
| `GET /api/stacks/:id` | Current normalized resource state for a listed stack   |

Listing runs discovery on demand, without polling or schedules. IDs are random,
process-scoped identifiers with no encoded locator. They remain stable across
scans while a stack remains present, then expire when it disappears or the server
restarts. They are normalized, authenticated client-visible identifiers; the
server never persists them. Do not emit them or stack metadata through public
routes or telemetry. Browsers must not persist provider coordinates or authenticated stack/resource metadata.

Discovery reports sanitized reason codes for failed projects, SSO profiles and
buckets while continuing other sources. A discovered entrypoint with no state
cannot supply an app or stage and contributes no stack row. Remote resource
counts and Alchemy versions remain unknown until the corresponding state or
lockfile establishes them. Discovery is capped at 1000 projects/stacks, 100 SSO
profiles, 1000 candidate buckets per profile and two minutes per list request.

The one public authentication route, `POST /auth/bootstrap`, exchanges a code
from the URL fragment for an HttpOnly, SameSite=Strict owner cookie. Codes are
single-use and expire after 60 seconds; a fresh mint replaces an unspent code.
The page removes the fragment before exchanging it. Codes are minted and
announced only after the authenticated HTTP listener is ready. Credential URLs
go only to stdout and the browser opener, never logs or telemetry. Session tokens
remain in the server and HttpOnly cookie. Every unsafe API method is refused,
including apply and destroy. Reads reject foreign origins and cross-site browser
requests. Listener and request Host are restricted to the bound loopback address.

## Browser views

Import `StackListView`, `StackDetailView` and `ResourceDetailView` from `@knpkv/alchemy-console/views` and its stylesheet from
`@knpkv/alchemy-console/views/style.css`. Mount them inside a Rly style/theme boundary.
Views consumers supply the optional React, React DOM and Rly peers; the standalone
browser shell already bundles them.
The application supplies normalized presentation data, a product label, host
sign-in instruction, read actions and real UI destinations. `StackListView` accepts
optional `stackHref`; without a destination, stages and counts remain text.
`StackDetailView` has controlled Resources/Outputs/State tabs and `resourceHref`.
`ResourceDetailView` accepts `stackHref` and `resourceHref`. Views fetch nothing,
read no configuration and persist no data. The standalone detail wrapper adds
breadcrumbs and Read again outside the referenced module content. Phone list
links use separated stage/count lines to keep their 44px targets disjoint. `Ready.checkedAt` describes the actual completed
request. Replace state with `Loading` before reading; failures and unauthorized
states contain no previous rows. Only normalized authenticated client-visible
stack metadata belongs here, never raw provider locators or credentials.

The standalone client uses the typed API and sends same-origin cookies with
no-store requests. The fragment is removed from history before its bootstrap
POST. Tokens never enter storage, logs or telemetry. CSS and font assets are
served from the same listener with a self-only CSP and no application-authored inline
style markup. Pinned Rly/Radix tabs assign `outline: none` on their tab list and
`animation-duration: 0s` on an initially mounted panel through trusted CSSOM
properties. Those framework effects require no CSP relaxation; serialized inline
style markup remains blocked. The
decorative empty-state SVG uses the approved Stacks illustration from this MIT
repository, with presentation attributes rather than inline styles. The State empty panel uses
the original decorative 56px Stacks2c procedural creature from the same MIT repo;
both SVGs remain external same-origin assets.

## Data readers

The root export provides project discovery, lockfile version lookup, local
state metadata and SSO/S3 readers for server-side consumers.

`discoverProjects(directory)` scans an explicit root for `alchemy.run.ts` without
importing or executing it. It skips `.git`, `node_modules`, `.alchemy`, `.direnv`,
`.cache`, and `dist`, deduplicates directory aliases, and rejects symlinks outside
the root. Directory errors fail the scan rather than hiding inaccessible projects.

`readAlchemyVersion(projectDirectory, searchRoot)` reads the nearest pnpm or Bun
text lockfile within the root. pnpm resolves the project's exact workspace
importer; Bun reads the resolved `alchemy` package tuple. Missing lockfiles or an
unresolved Alchemy version return `null`. Invalid lockfiles fail explicitly.

`readLocalState(directory, alchemyVersion)` reads
`.alchemy/state/<app>/<stage>/<encoded-fqn>.json` for beta.74 and beta.77. Other
versions, including unknown versions, fail with `unsupported-version`. Resource
metadata includes FQN, logical ID, type, status, and namespace parent. Action rows
are validated and excluded. Temporary files are ignored. Missing
state returns `available: false`; an existing empty stage returns an empty resource
list with `available: true`. JSON names must match the stored FQN encoding.

## SSO and S3

`discoverSsoProfiles(configFile)` reads the explicitly supplied AWS config file.
It resolves modern `sso_session` references and legacy inline SSO settings,
including the default profile. Static keys, credential processes, assumed-role
chains, and service sections are excluded. Missing config returns an empty list;
incomplete or conflicting SSO configuration fails with a safe tagged reason.
The executable will supply the local config path; this layer does not choose an
ambient profile or execute login commands.

`s3ReaderLayer(profile)` uses `ssoCredentialsLayer()` and an Effect `HttpClient`.
Credentials come exclusively from the selected SSO identity and cached local
session. There is no environment, static-key, instance-metadata, or process
credential fallback. The SDK may refresh an existing SSO session in its local
token cache. Credentials remain redacted in server memory and are used only for
request signing. The profile supplies the SSO portal region; listed bucket regions
route S3 requests. Object requests include the selected account as
`ExpectedBucketOwner`. S3 transport tracing is disabled so private request URLs
and signing headers cannot enter telemetry.

`discoverS3Buckets()` paginates the selected account's owned buckets and selects
names containing `alchemy-state`. A caller may supply another naming predicate
or explicit server-private bucket locators. Listing owned buckets cannot discover
every cross-account bucket that a role might be allowed to read. Denied access or
expired sessions fail explicitly; they do not produce an empty account catalog.
An API can report these failures per profile while continuing other profiles.

`discoverS3Stacks(bucket)` recognizes `<optional-prefix><app>/<stage>/<encoded-fqn>.json`
keys. `listS3Versions(bucket, prefix)` returns persisted object version coordinates
and deletion markers. Both S3 continuation markers are retained; repeated markers
fail. `readS3State(stack, alchemyVersion?)` reads each latest non-deleted resource
using its listed version ID. Temporary files are excluded; supported-version stack outputs use their selected
current version and the key-only decoder below.
`readS3Resource(stack, key, versionId)` reads one historical version after checking
that the key belongs to that stack. JSON names must match the resource FQN.
Latest deletion markers never resurrect an older resource or output dictionary. Null versions from
unversioned or suspended buckets are supported. Multiple resource reads are not
an atomic snapshot of a deployment.

Remote state alone does not prove the installed Alchemy version or last successful
deploy. Both remain `null` unless a matching lockfile supplies the version.
Known beta.74/beta.77 resource shapes are validated even when remote version is
unknown; an explicitly supplied unsupported version fails. The adapter imports
only `ListBuckets`, `ListObjectVersions`, and `GetObject`. It never builds Alchemy's
state-store layer, which can create or reconfigure buckets.

Read-only IAM access needs `s3:ListAllMyBuckets`, `s3:ListBucketVersions`, and
`s3:GetObjectVersion` for version-pinned reads. No write policy is required. See the AWS
[version listing](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html)
and [object reading](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
references. No live AWS or Alchemy stack is used by the tests.

The flat resource list retains construct parents, including parents without their
own resource row. Resource-own identity is selected only from documented beta.74
and beta.77 `attr` fields. The AWS allowlist is Lambda Function, S3 Bucket,
DynamoDB Table, SQS Queue, IAM Role/Policy, CloudFront Distribution, Logs LogGroup,
ACM Certificate and CloudWatch Alarm/Dashboard. Commercial `aws` ARNs must match
the exact resource type and own name. Console links use the AWS-owned
[toolkit resource resolver](https://github.com/aws/aws-toolkit-vscode/blob/e1b0f9bc573bac1830f0b9aa7ced25a6c69bb477/packages/core/src/awsService/cloudformation/consoleLinksUtils.ts).
Other partitions and unknown/custom types have no link. S3 resource region/account
must come from that resource, never the backend bucket or SSO selector.

`Cloudflare.Worker` uses its own validated account, worker ID and worker name in
the documented service route. Local/dev identities, dispatch namespaces and
parent-owned versions have no regular service link. R2 Bucket and DNS Record may
expose validated own identity but have no console link when an official route or
required own routing identity is unproven. DNS `modifiedOn` alone supplies Last
updated, preserving valid complete UTC precision. No other generic updated time
or successful deployment time is inferred. Missing metadata remains null.
Absent provider mode can represent legacy cloud state; explicit local or invalid
modes never authorize a provider link.

`downstream` records dependents, not dependencies. The view builds a bounded
reverse index for the complete returned stack. Missing edges, missing rows,
duplicates or an incomplete graph make dependency knowledge unavailable rather
than inventing an empty dependency list. Local file timestamps never prove a
successful deployment.

The supported stack output file is a JSON root dictionary. Only validated keys
cross normalization; each value is `Hidden`, with a null description. Plaintext,
including a URL, never proves safety. Exact successfully read `{}` proves no
outputs. Missing, unreadable, malformed, scalar/array or root encoding-marker
state is unavailable, including reserved envelopes with sibling fields. Unknown
remote version cannot establish an output format. Output values are never
traversed or transported. The pure exported view additionally accepts `SafeText`
with `proof: "explicit-non-sensitive"` only from a trusted host projection with
independent proof. The persisted readers and standalone API never produce it.

## Private data and redaction

Discovered directories and entrypoints are server-private filesystem locators.
Keep them in server memory; do not persist them to browser storage or emit them
through HTTP, logs, telemetry, or public error messages. The normalized stack and
resource summaries may cross an authenticated owner API boundary. They must never
appear on unauthenticated routes or public telemetry.

Persisted Alchemy state can contain plaintext secret payloads inside
`__redacted__` marker objects. This package never invokes Alchemy's reviver or
decrypts anything. It discards raw props, attrs, old state, action inputs and output values. Only the
explicit resource-own attr allowlist and output keys are normalized.
Marker objects in metadata become `<redacted>`, including sibling fields. Parsing
errors include only a tagged reason, never raw contents or parser diagnostics.
Reads are capped at 8 MiB per file and directory listings at 50,000 entries. Resource identities are bounded to 1024
characters, dependency graphs to 100,000 edges, and output dictionaries to 1000
keys of at most 256 characters.

SSO profiles retain server-private names, config paths, account/role selectors,
session names, start URLs, and routing regions. S3 bucket names, state prefixes,
object keys, version IDs, and pagination markers are also server-private. Their
persisted representation is AWS config or S3 object coordinates; console code
holds them in server memory only. They must not cross HTTP, browser storage,
logs, telemetry, or public errors. Only normalized `StackState`, `ResourceSummary` and `OutputSummary` fields may
cross the authenticated owner API. Resource FQNs, construct parents, provider IDs,
own account/region, allowlisted console URLs, documented updated timestamps,
downstream identities and output keys are authenticated client-visible metadata.
Stack IDs and resource FQNs also appear in validated UI query routes and browser
history. They are not backend locators. Never emit them on public routes, in logs
or telemetry, or persist them in browser storage. Credential-bearing
`SsoCredentials` results remain solely inside the signing boundary. S3 reads have
the same 8 MiB payload cap and a 50,000-entry / 100-page listing cap.

Cloudflare profile configuration remains server-side. This phase has no plan,
apply or destroy execution.

## Format references

Synthetic test states follow the pinned upstream
[resource format](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/ResourceState.ts),
[local layout](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/LocalState.ts),
and [state encoding](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/StateEncoding.ts).
No real stack, account, bucket, credential, or project path is included in fixtures.

Run `pnpm --filter @knpkv/alchemy-console test` for the focused fixture tests.
Build workspace dependencies before the package's `check` script.

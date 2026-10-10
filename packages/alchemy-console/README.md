# @knpkv/alchemy-console

Read-only data layer for a local Alchemy stack console. The package adds
project discovery, lockfile version lookup, local state metadata, and SSO/S3
readers. There is no executable or HTTP listener yet. Authenticated API and
design-backed Rly screens follow in separate PRs.

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
are validated and excluded. Stack output and temporary files are ignored. Missing
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
using its listed version ID. Stack outputs and temporary files are excluded.
`readS3Resource(stack, key, versionId)` reads one historical version after checking
that the key belongs to that stack. JSON names must match the resource FQN.
Latest deletion markers never resurrect an older resource. Null versions from
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

The flat resource list retains namespace parents, including parents without their
own resource row. A consumer can group these into a tree. Provider IDs, account,
region, console links, and last deploy are currently `null`. Local file timestamps
do not prove a successful deployment. Readers do not invent missing metadata.

## Private data and redaction

Discovered directories and entrypoints are server-private filesystem locators.
Keep them in server memory; do not persist them to browser storage or emit them
through HTTP, logs, telemetry, or public error messages. The normalized stack and
resource summaries may cross an authenticated owner API boundary. They must never
appear on unauthenticated routes or public telemetry.

Persisted Alchemy state can contain plaintext secret payloads inside
`__redacted__` marker objects. This package never invokes Alchemy's reviver or
decrypts anything. It discards props, attrs, old state, action inputs, and outputs.
Marker objects in metadata become `<redacted>`, including sibling fields. Parsing
errors include only a tagged reason, never raw contents or parser diagnostics.
Reads are capped at 8 MiB per file and directory listings at 50,000 entries.

SSO profiles retain server-private names, config paths, account/role selectors,
session names, start URLs, and routing regions. S3 bucket names, state prefixes,
object keys, version IDs, and pagination markers are also server-private. Their
persisted representation is AWS config or S3 object coordinates; console code
holds them in server memory only. They must not cross HTTP, browser storage,
logs, telemetry, or public errors. Only normalized `StackState` and
`ResourceSummary` fields may cross the authenticated owner API. Credential-bearing
`SsoCredentials` results remain solely inside the signing boundary. S3 reads have
the same 8 MiB payload cap and a 50,000-entry / 100-page listing cap.

Cloudflare profiles will also remain server-side. The UI will never apply or
destroy. Plan diffs remain on demand, with no scheduled execution.

## Format references

Synthetic test states follow the pinned upstream
[resource format](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/ResourceState.ts),
[local layout](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/LocalState.ts),
and [state encoding](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/StateEncoding.ts).
No real stack, account, bucket, credential, or project path is included in fixtures.

Run `pnpm --filter @knpkv/alchemy-console test` for the focused fixture tests.
Build workspace dependencies before the package's `check` script.

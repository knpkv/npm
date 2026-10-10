# @knpkv/alchemy-console

Read-only data layer for a local Alchemy stack console. This first package adds
project discovery, lockfile version lookup, and local state metadata. There is
no executable or HTTP listener yet. S3 discovery, authenticated API, and the
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

No credentials are read in this package revision. Later adapters keep SSO and
Cloudflare credentials server-side, expose only read operations, and keep raw
bucket names, keys, and provider locators server-private. The UI will never apply
or destroy. Plan diffs remain on demand, with no scheduled execution.

## Format references

Synthetic test states follow the pinned upstream
[resource format](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/ResourceState.ts),
[local layout](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/LocalState.ts),
and [state encoding](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.77/packages/alchemy/src/State/StateEncoding.ts).
No real stack, account, bucket, credential, or project path is included in fixtures.

Run `pnpm --filter @knpkv/alchemy-console test` for the focused fixture tests.
Build workspace dependencies before the package's `check` script.

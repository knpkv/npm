# Design

## Architecture

The existing CodePipeline adapter remains the single provider boundary. Its
three layers gain narrow responsibilities:

1. `CodePipelineReadProvider` owns credentials and direct AWS calls.
2. `CodePipelineReadClient` Schema-decodes provider data into bounded internal
   models.
3. `CodePipelinePluginDefinition` normalizes entities and owns the private
   governed-action lifecycle under the same runtime identity.

The host plugin contract gains a vendor-neutral optional pipeline read surface:

```text
authenticated HTTP request
  -> workspace authorization
  -> scoped PluginConnectionMap lease
  -> negotiated pipeline.logs / pipeline.artifact reader
  -> CodePipeline action identity revalidation
  -> CloudWatch Logs or S3 provider call
  -> bounded Schema-decoded response
```

Mutations retain the existing sealed path:

```text
proposal -> authorization -> durable preparation -> final preflight
  -> durable started intent -> AuthorizedPluginExecutor -> AWS
  -> receipt or unknown -> durable fold -> reconciliation
```

### Module changes

- `domain/plugins/pipeline.ts`: log/artifact request and response schemas.
- `PluginConnection.ts`: optional `PluginPipelineReaderV1`.
- `PluginCapabilityCodecs.ts`, `negotiation.ts`, and `PluginDefinition.ts`:
  negotiate and wrap `pipeline.logs` and `pipeline.artifact`.
- `CodePipelineReadProvider.ts`: pipeline state, CloudWatch log, S3 range, and
  mutation operations.
- `CodePipelineReadClient.ts`: decoded state/read/write models and helpers.
- `CodePipelinePluginDefinition.ts`: canonical proposals, preflight, dispatch,
  cancellation policy, and reconciliation remain one private subsystem.
- `api/codepipeline.ts`, application service, and handlers: authenticated
  workspace read endpoints.
- first-party runtime registry: executable CodePipeline runtime wiring.

The governed-action subsystem intentionally remains inside the deep plugin
definition module. Proposal normalization, exact snapshot loading, runtime
identity verification, token hashing, idempotent dispatch replay, and
reconciliation all share private state. Extracting them would expose a broad
parameter seam with no independent consumer and make those invariants easier to
split accidentally; the exported definition remains the single narrow
interface.

## Action model

### Start

The request targets the configured pipeline entity by its exact ARN
and pipeline-definition revision; it does not require a prior execution.
It carries explicit source action/revision pairs. Proposal validates the exact
unique source-action set and each revision type against its declared provider,
then freezes the sorted order. Preflight repeats those checks against the
current pipeline definition. Dispatch calls `StartPipelineExecution` with a
token derived from the governed idempotency key and payload digest.
CodeCommit accepts commit IDs, ECR accepts image digests, and S3 accepts version
IDs plus object keys only when `AllowOverrideForS3ObjectKey` is enabled;
unrecognized source providers fail closed.

### Stop

The request targets an execution and carries `mode: "wait" | "abandon"` plus a
bounded reason. Proposal/preflight require the exact execution revision and
`InProgress` status. Abandon has critical impact; wait has high impact.

### Manual approval

The request targets an action and carries Approved/Rejected plus a bounded
summary. Proposal loads the action and current pipeline state, verifies that it
is a pending Approval action, and freezes only a one-way digest of the one-time
token. The raw token remains ephemeral and never enters the canonical payload,
summaries, or receipts. Preflight reloads the token and repeats its digest and
revision check. AWS validates the token atomically at dispatch.

### Retry

Retry targets a failed or stopped execution. Proposal captures its immutable
source revisions and original execution ID. Dispatch uses
`StartPipelineExecution`, not `RetryStageExecution`, because the issue requires
a distinct execution. The deterministic client token prevents duplicates. The
durable governed-action target plus returned provider execution ID forms the
`retryOf` lineage without changing SQL.

## Read model

### Logs

The HTTP request identifies the connection, execution, action, expected action
revision, cursor, and requested limit. The plugin reloads the exact action,
validates its log-stream ARN, then calls CloudWatch Logs with configured hard
bounds. Returned events contain timestamp, ingestion timestamp, and bounded
message text. The cursor is opaque to the browser and scoped by the request
identity.

### Artifacts

The HTTP request identifies an artifact by action, direction, and name plus a
byte range. The plugin reloads the exact action and selects the corresponding
artifact metadata server-side. S3 receives a single bounded range request.
The response is `application/octet-stream`, attachment-only, private/no-store,
and `nosniff`. Partial slices return `206` with an exact `Content-Range`,
complete objects return `200`, and exhausted ranges return `416` with
`bytes */total`. Bucket, key, ARN, and signed URLs never enter normalized
events or leave the server.

## Error handling strategy

- Schema/configuration failures occur before provider calls.
- Not-found and stale identity map to conflict/not-found application errors.
- AWS authentication, authorization, throttling, timeout, conflict, and outage
  remain distinct typed plugin failures.
- Known AWS semantic rejections return confirmed failed receipts.
- Timeouts/outages after mutation dispatch return unknown outcomes with a safe
  reconciliation key.
- Start/retry reconciliation reuses the exact AWS idempotency token; this may
  repeat the transport request but cannot create a second logical execution.
- Stop and approval reconcile from execution/action state without replay.

## Testing strategy

- Pure schema and codec tests prove bounds and capability negotiation.
- Injectable provider tests assert exact calls and failure mapping.
- Plugin tests cover proposal, preflight, dispatch, reconciliation, no-leak
  serialization, and call counts.
- HTTP/application tests prove session/workspace isolation before provider
  acquisition and safe response headers.
- Production registry composition proves exact-one authorized dispatch.
- Full lint/check/build/test gates remain required.

## Key implementation patterns

```ts
const tokenDigest =
  yield *
  digestGovernedActionPayload({
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
const token = `cc-${tokenDigest}`

yield *
  provider.startPipelineExecution({
    account,
    pipelineName,
    clientRequestToken: token,
    sourceRevisions
  })
```

```ts
const selected = snapshot.actionCollection.actions.find(
  (action) => action.executionId === request.executionId && action.actionExecutionId === request.actionExecutionId
)
if (selected === undefined || actionRevision(selected) !== request.expectedRevision) {
  return (
    yield *
    new PluginConflictFailure({
      operation: "pipeline-artifact-read",
      diagnosticCode: "codepipeline-action-revision-changed"
    })
  )
}
```

```ts
const connection = Context.get(
  yield * pluginConnections.contextEffect({ workspaceId, pluginConnectionId }),
  PluginConnection
)
```

## Security decisions

- No provider URL or provider storage coordinate enters API schemas.
- Only a one-way approval-token digest enters the canonical action payload;
  the raw token remains ephemeral provider state.
- Provider-call code never logs inputs, credentials, responses, or causes.
- Artifact responses force download and disable caching/sniffing.
- Log messages are treated as provider content, bounded as untrusted text, and
  never interpolated into server logs.

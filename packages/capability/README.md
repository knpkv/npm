# @knpkv/capability

Typed capability contracts: one definition of something a product can do, with Effect Schema input, output and failure, shared by every surface that exposes it (Relay tools, MCP, HTTP, CLI).

## Define, implement, invoke

```ts
import { defineContract, implement, invoke, ObjectRef } from "@knpkv/capability"
import { Effect, Schema } from "effect"

class PullRequestNotFound extends Schema.TaggedError<PullRequestNotFound>()("PullRequestNotFound", {
  id: Schema.String,
  fix: Schema.String
}) {}

export const getPullRequestContract = defineContract({
  name: "get_pull_request",
  description: "Read one pull request.",
  access: "read",
  input: Schema.Struct({ id: Schema.String }),
  output: PullRequestSummary,
  failure: PullRequestNotFound,
  cites: (pullRequest) => [pullRequest.ref]
})

export const getPullRequest = implement(getPullRequestContract, ({ id }) => repository.get(id))

// A surface calls it with untrusted JSON:
const result = invoke(getPullRequest, { id: "42" }) // Effect<{ output: Json; cites: ObjectRef[] }, ...>
```

## Rules the types enforce

- **Names** must match `^[a-zA-Z0-9_-]{1,64}$` (snake_case by convention). `defineContract` throws `ContractNameInvalid` when the module loads otherwise.
- **Input** is a `Schema.Struct` of service-free fields, so tool arguments, CLI flags and HTTP queries all get named fields.
- **Failures** are declared. Each is a tagged error with a `message` and a `fix`. A handler that fails with anything else does not typecheck; an error raised anyway is a defect, which surfaces report as a generic internal error without its message.
- **Access**: `read` runs. `write` (a person confirms) and `host` (a host approval) must carry `reversible` and a pure `describe(input)`, which returns the exact `PendingAction` the person deciding sees. `describeCall` accepts only those.

## What a surface gets

- `invoke(capability, args)` decodes `args` with the input schema, runs the handler, and encodes the output as JSON with its citations. A declared failure becomes `CapabilityFailed` with `tag`, `reason`, `fix` and the encoded failure; invalid arguments become `CapabilityInputInvalid`.
- `describeCall(contract, args)` returns the pending action for decoded arguments.
- `inputJsonSchema(contract)` returns the input's JSON Schema for a tool list.

Gating (confirmations, approvals) belongs to the surface: call `invoke` only after a gated action has been agreed to.

/**
 * Capability contracts: one typed definition of something a product can do, shared by every surface
 * that exposes it (Relay tools, MCP, HTTP, CLI).
 *
 * **Mental model**
 *
 * - **A {@link Contract} is data plus pure functions.** Name, description, input, output and failure
 *   are Effect Schema; `cites` and `describe` are pure. Clients, the Relay dock and CLI help can import
 *   a contract without pulling in the handler or its services.
 * - **{@link implement} binds the handler.** Its failure type is the contract's declared failure, so an
 *   undeclared error does not typecheck; one raised anyway is a defect.
 * - **Access decides who must agree first.** `read` runs. `write` waits for the user to confirm the
 *   exact {@link PendingAction} that `describe` returns. `host` waits for a host approval. Only gated
 *   contracts carry `describe` and `reversible`.
 *
 * @example
 * ```ts
 * class PullRequestNotFound extends Schema.TaggedError<PullRequestNotFound>()("PullRequestNotFound", {
 *   ref: ObjectRef,
 *   fix: Schema.String
 * }) {}
 *
 * export const getPullRequestContract = defineContract({
 *   name: "get_pull_request",
 *   description: "Read one pull request: title, author, status, revisions and approval rules.",
 *   access: "read",
 *   input: Schema.Struct({ ref: ObjectRef }),
 *   output: PullRequestSummary,
 *   failure: PullRequestNotFound,
 *   cites: (pullRequest) => [pullRequest.ref]
 * })
 *
 * export const getPullRequest = implement(getPullRequestContract, ({ ref }) => repository.get(ref))
 * ```
 *
 * @module
 */
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const NonEmptyName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))

/** A product object a capability reads, changes or cites. Product-namespaced and stable across restarts. */
export const ObjectRef = Schema.Struct({
  product: NonEmptyName,
  kind: NonEmptyName,
  id: NonEmptyName
})
export interface ObjectRef extends Schema.Schema.Type<typeof ObjectRef> {}

/** The exact action a gated capability is about to take, shown to the person who must agree, verbatim. */
export const PendingAction = Schema.Struct({
  verb: NonEmptyName,
  target: ObjectRef,
  args: Schema.Json
})
export interface PendingAction extends Schema.Schema.Type<typeof PendingAction> {}

const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/u

/** A contract name that every surface accepts as a tool or command name (MCP's rule; snake_case by convention). */
export const isToolName = (name: string): boolean => toolNamePattern.test(name)

/** A contract was defined with a name some surface would reject. Thrown at definition, not at projection. */
export class ContractNameInvalid extends Schema.TaggedError<ContractNameInvalid>()("ContractNameInvalid", {
  name: Schema.String
}) {
  override get message(): string {
    return `Capability name "${this.name}" must match ${toolNamePattern.source} (snake_case by convention)`
  }
}

/** A schema with no services on either side, so any surface can decode and encode it. */
export type PlainSchema = Schema.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/** Input is always a struct of named fields: tool arguments, CLI flags and HTTP queries all need names. */
export type InputSchema = Schema.Struct<Record<string, PlainSchema>> & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/**
 * Declared failures. Each is a tagged error with a `fix` that tells the reader what to do next; its
 * `message` is model-readable. `Schema.Never` declares a capability that cannot fail.
 */
export type FailureSchema = PlainSchema & {
  readonly Type: { readonly _tag: string; readonly message: string; readonly fix: string }
}

/** Who must agree before a capability runs. */
export type Access = "read" | "write" | "host"

/** The fields every contract has, whatever its access. */
export interface ContractFields<
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema
> {
  readonly _tag: "Contract"
  readonly name: Name
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly failure: Failure
  /** The objects an answer may cite after this call. */
  readonly cites: (output: Output["Type"]) => ReadonlyArray<ObjectRef>
}

/** Access for a capability that runs without anyone agreeing first. */
export interface ReadAccess {
  readonly access: "read"
}

/** Access for a capability a person (`write`) or a host approval (`host`) must agree to first. */
export interface GatedAccess<Input> {
  readonly access: "write" | "host"
  /** Shown on the confirmation: whether the action can be undone. */
  readonly reversible: boolean
  /** The action as the person deciding will see it. Pure: no services. */
  readonly describe: (input: Input) => PendingAction
}

/** A contract that runs without anyone agreeing first. */
export type ReadContract<
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema
> = ContractFields<Name, Input, Output, Failure> & ReadAccess

/** A contract a person or a host approval must agree to before it runs. */
export type GatedContract<
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema
> = ContractFields<Name, Input, Output, Failure> & GatedAccess<Input["Type"]>

/** One typed capability definition. Data plus pure functions; the handler is bound by {@link implement}. */
export type Contract<
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema
> = ReadContract<Name, Input, Output, Failure> | GatedContract<Name, Input, Output, Failure>

type Options<C> = C extends { readonly cites: infer Cites } ? Omit<C, "_tag" | "cites"> & { readonly cites?: Cites }
  : never

const citesNothing = (): ReadonlyArray<ObjectRef> => []

/**
 * Define a contract. Throws {@link ContractNameInvalid} at definition when `name` is not a valid tool
 * name, so a bad name fails when the module loads rather than when one surface projects it.
 */
export function defineContract<
  const Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema
>(options: Options<ReadContract<Name, Input, Output, Failure>>): ReadContract<Name, Input, Output, Failure>
export function defineContract<
  const Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema
>(options: Options<GatedContract<Name, Input, Output, Failure>>): GatedContract<Name, Input, Output, Failure>
export function defineContract<
  const Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema
>(options: Options<Contract<Name, Input, Output, Failure>>): Contract<Name, Input, Output, Failure> {
  if (!isToolName(options.name)) throw new ContractNameInvalid({ name: options.name })
  const cites = options.cites ?? citesNothing
  return options.access === "read"
    ? { ...options, _tag: "Contract", access: "read", cites }
    : { ...options, _tag: "Contract", access: options.access, cites }
}

/** A contract bound to the handler that does the work. */
export interface Capability<
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema,
  Requirements
> {
  readonly _tag: "Capability"
  readonly contract: Contract<Name, Input, Output, Failure>
  readonly handler: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], Requirements>
}

/**
 * Bind a handler to its contract. The handler may fail only with the contract's declared failure;
 * anything else does not typecheck, and an error raised anyway is a defect.
 */
export const implement = <
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema,
  Requirements = never
>(
  contract: Contract<Name, Input, Output, Failure>,
  handler: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], Requirements>
): Capability<Name, Input, Output, Failure, Requirements> => ({ _tag: "Capability", contract, handler })

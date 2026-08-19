/**
 * Structural helpers for walking and rewriting ADF documents.
 *
 * Deliberately independent of `AdfWalker`, which exists to emit markdown and
 * knows about every node's rendering. Everything here treats a document as a
 * plain tree of `{ type, content?, text? }` so it can serve the paths that must
 * never go through the markdown projection: the push-time census guard and the
 * surgical `page patch` edits.
 *
 * @module
 * @internal
 */
import * as Predicate from "effect/Predicate"

/**
 * The minimum shape every ADF node shares. Nodes carry plenty more (`attrs`,
 * `marks`, …) but nothing here needs to understand those, and preserving them
 * untouched is the entire point.
 */
export interface AdfNodeLike {
  readonly type: string
  readonly content?: ReadonlyArray<unknown>
  readonly text?: string
  readonly attrs?: unknown
}

export const isAdfNode = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & AdfNodeLike =>
  Predicate.isObject(value) && "type" in value && Predicate.isString(value["type"])

const childrenOf = (node: AdfNodeLike): ReadonlyArray<unknown> => Array.isArray(node.content) ? node.content : []

/**
 * Visit every node in document order, root first.
 */
export const walkAdf = <UnparsedInput>(root: UnparsedInput, visit: (node: AdfNodeLike) => void): void => {
  if (!isAdfNode(root)) return
  visit(root)
  for (const child of childrenOf(root)) walkAdf(child, visit)
}

/**
 * Count nodes by `type`.
 *
 * Used as a cheap structural fingerprint: two documents that should differ
 * only in prose must have identical censuses. A drift in `blockCard` or
 * `expand` counts is how silent round-trip duplication announces itself.
 */
export const adfNodeCensus = <UnparsedInput>(root: UnparsedInput) => {
  const census: Record<string, number> = {}
  walkAdf(root, (node) => {
    census[node.type] = (census[node.type] ?? 0) + 1
  })
  return census
}

export interface CensusDelta {
  readonly type: string
  readonly before: number
  readonly after: number
}

/**
 * Node types whose count must not move unless the edit deliberately targeted
 * them. Prose edits change `text` and `paragraph` counts constantly; these are
 * container and embed nodes that a wording change has no business touching,
 * and they are exactly the ones the markdown round-trip has been observed to
 * duplicate or drop.
 */
export const STRUCTURAL_NODE_TYPES: ReadonlySet<string> = new Set([
  "blockCard",
  "embedCard",
  "extension",
  "bodiedExtension",
  "inlineExtension",
  "multiBodiedExtension",
  "expand",
  "nestedExpand",
  "table",
  "layoutSection",
  "mediaSingle",
  "mediaGroup",
  "taskList",
  "decisionList"
])

/**
 * Report structural node types whose counts differ between two documents.
 */
export const structuralCensusDelta = <UnparsedInput, UnparsedInput2>(
  before: UnparsedInput,
  after: UnparsedInput2
): ReadonlyArray<CensusDelta> => {
  const a = adfNodeCensus(before)
  const b = adfNodeCensus(after)
  const deltas: Array<CensusDelta> = []
  for (const type of STRUCTURAL_NODE_TYPES) {
    const from = a[type] ?? 0
    const to = b[type] ?? 0
    if (from !== to) deltas.push({ type, before: from, after: to })
  }
  return deltas
}

/**
 * The url `AdfWalker.blockCard` would render, or `undefined` if it would find
 * none. Mirrors `cardUrl` there deliberately: this predicate is only correct
 * while it agrees with the walker about which cards have a spelling.
 */
const cardUrl = (node: AdfNodeLike): string | undefined => {
  if (!Predicate.isObject(node.attrs)) return undefined
  const url = node.attrs["url"]
  if (Predicate.isString(url) && url.length > 0) return url
  const data = node.attrs["data"]
  const dataUrl = Predicate.isObject(data) ? data["url"] : undefined
  return Predicate.isString(dataUrl) && dataUrl.length > 0 ? dataUrl : undefined
}

/**
 * Whether a node survives the markdown projection unchanged.
 *
 * Deliberately narrow: at block level `AdfWalker` wraps cards, expands, task
 * lists and the rest in `encodedBlockNode`, whose open marker carries the
 * *entire* node as JSON (AdfWalker.ts:523-528), and `resolveEncodedBlockNode`
 * restores it verbatim. Macros get the same treatment through their
 * `<!-- adf:… attrs=… -->` marker. So a datasource card, a TOC and an excerpt
 * all round-trip and must stay pushable — `RoundTripFixpoint.test.ts` proves
 * the datasource case. What genuinely cannot survive:
 *
 * - a `blockCard`/`embedCard` with no resolvable url — `AdfWalker` never
 *   reaches `encodedBlockNode` for it and emits the `unsupported ADF node`
 *   comment instead (AdfWalker.ts:588-593), so the node is simply gone;
 * - `multiBodiedExtension` — `AdfWalker` has no case for it, so it falls to
 *   the `unsupported ADF node` comment and its bodies are dropped;
 * - a `bodiedExtension` *inside a table*, where the cell holds only the open
 *   marker (AdfWalker.ts:283) and the return trip fails outgoing schema
 *   validation outright rather than losing the body quietly.
 *
 * Being inside a table does *not* by itself make a node unsafe: the table is
 * wrapped in its own `encodedBlockNode`, whose marker carries every descendant
 * verbatim, so a datasource card in a cell comes back intact.
 * `RoundTripFixpoint.test.ts` measures each of these rather than deducing them
 * from the walker — the classification was wrong twice by reading the render
 * path alone and missing what the enclosing marker restores.
 *
 * A url-less card is knowingly over-refused. Generalizing "an enclosing marker
 * carries it" to any encoded-block ancestor looks right and is not: measured
 * through the converter, `expand > card` and `table > cell > card` do come back,
 * but `layoutSection > column > card`, `layoutSection > expand > card` and
 * `table > cell > nestedExpand > card` all fail the return trip outright. The
 * safe set therefore depends on the whole ancestor chain, not on one flag, and
 * a guard should over-refuse: the refusal names `page put`/`page patch` and
 * `--force`, whereas a wrong exemption turns that into an opaque
 * `ConversionError`. Re-measure before narrowing this — do not reason it out.
 *
 * `inTable` is the caller's ancestry context; the node alone cannot tell.
 */
export const isRoundTripUnsafeNode = (node: AdfNodeLike, inTable = false): boolean => {
  if (node.type === "multiBodiedExtension") return true
  if (node.type === "bodiedExtension") return inTable
  if (node.type !== "blockCard" && node.type !== "embedCard") return false
  return cardUrl(node) === undefined
}

/**
 * List the distinct round-trip-unsafe node types present in a document.
 */
export const roundTripUnsafeNodeTypes = <UnparsedInput>(root: UnparsedInput): ReadonlyArray<string> => {
  const found = new Set<string>()
  const visit = <UnparsedInput>(value: UnparsedInput, inTable: boolean): void => {
    if (!isAdfNode(value)) return
    if (isRoundTripUnsafeNode(value, inTable)) found.add(value.type)
    const nested = inTable || value.type === "table"
    for (const child of childrenOf(value)) visit(child, nested)
  }
  visit(root, false)
  return [...found].sort()
}

type MappedAdfNode<Input> = Input | AdfNodeLike | null

const mapNode = <UnparsedInput>(
  node: UnparsedInput,
  f: (node: AdfNodeLike) => AdfNodeLike | null
): MappedAdfNode<UnparsedInput> => {
  if (!isAdfNode(node)) return node
  const mapped = f(node)
  if (mapped === null) return null
  if (!Array.isArray(mapped.content)) return mapped
  const content = mapped.content.map((child) => mapNode(child, f)).filter((child) => child !== null)
  return { ...mapped, content }
}

export interface TextReplacement {
  readonly replacements: number
  readonly doc: unknown
}

/**
 * Replace literal text across `text` nodes, leaving marks and every other
 * attribute untouched.
 *
 * Only whole occurrences inside a single text node are replaced. ADF splits a
 * run at every mark boundary, so a phrase spanning a `code` span lives in
 * several nodes and will not match — that is reported as zero replacements
 * rather than guessed at, because silently rewriting across a boundary would
 * lose the mark.
 */
export const replaceAdfText = <UnparsedInput>(
  root: UnparsedInput,
  search: string,
  replacement: string
): TextReplacement => {
  let replacements = 0
  const doc = mapNode(root, (node) => {
    if (node.type !== "text" || !Predicate.isString(node.text) || !node.text.includes(search)) return node
    replacements += node.text.split(search).length - 1
    return { ...node, text: node.text.replaceAll(search, replacement) }
  })
  return { doc, replacements }
}

export interface NodeSelector {
  readonly type: string
  readonly index?: number
}

/**
 * Parse a `type` or `type[n]` selector. `n` is a zero-based index into the
 * document-order occurrences of that node type.
 */
export const parseNodeSelector = (input: string): NodeSelector | null => {
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\[(\d+)\])?$/.exec(input.trim())
  if (!match) return null
  const type = match[1]
  if (type === undefined) return null
  return match[2] === undefined ? { type } : { type, index: Number(match[2]) }
}

export interface NodeDeletion {
  readonly deleted: number
  readonly doc: unknown
}

/**
 * Delete nodes matching a selector. Without an index every occurrence goes.
 */
export const deleteAdfNodes = <UnparsedInput>(root: UnparsedInput, selector: NodeSelector): NodeDeletion => {
  let seen = 0
  let deleted = 0
  const doc = mapNode(root, (node) => {
    if (node.type !== selector.type) return node
    const occurrence = seen++
    if (selector.index !== undefined && selector.index !== occurrence) return node
    deleted++
    return null
  })
  return { doc, deleted }
}

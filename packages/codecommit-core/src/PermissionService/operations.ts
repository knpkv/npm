/**
 * @title Operation registry — maps operation names to metadata
 *
 * Every AWS API call has a named operation with a category (read/write)
 * and human-readable description. The gate uses the category for UI
 * badge color; the description appears in the permission prompt modal.
 *
 * `OperationName` is a union of known builtin operations + `(string & {})`
 * for runtime extensions. This gives autocomplete for known ops while
 * allowing `registerOperation` to add new ones (e.g. approval rule CRUD).
 *
 * @internal
 */

export interface OperationMeta {
  readonly category: "read" | "write"
  readonly description: string
}

const op = (category: "read" | "write", description: string): OperationMeta => ({ category, description })

const BuiltinOperations = {
  getCallerIdentity: op("read", "Get current user identity"),
  listRepositories: op("read", "List all repositories"),
  listPullRequests: op("read", "List PR IDs for a repo"),
  getPullRequests: op("read", "Fetch PR details"),
  getPullRequest: op("read", "Single PR detail"),
  evaluatePullRequestApprovalRules: op("read", "Check approval status"),
  getPullRequestApprovalStates: op("read", "Get who approved"),
  getMergeConflicts: op("read", "Check merge conflicts"),
  getCommentsForPullRequest: op("read", "Fetch PR comments"),
  listBranches: op("read", "List branches"),
  getDifferences: op("read", "Diff stats"),
  createPullRequest: op("write", "Create a pull request"),
  updatePullRequestTitle: op("write", "Edit PR title"),
  updatePullRequestDescription: op("write", "Edit PR description")
} as const satisfies Record<string, OperationMeta>

export type BuiltinOperation = keyof typeof BuiltinOperations

// Known literals for autocomplete + string escape hatch for runtime extensions
export type OperationName = BuiltinOperation | (string & {})

const operations = new Map<string, OperationMeta>(Object.entries(BuiltinOperations))

const fallback = (name: string): OperationMeta => ({ category: "read", description: name })

export const getOperationMeta = (name: OperationName): OperationMeta => operations.get(name) ?? fallback(name)

export const allOperations = (): ReadonlyArray<readonly [string, OperationMeta]> => [...operations.entries()]

export const registerOperation = (name: string, meta: OperationMeta): void => {
  operations.set(name, meta)
}

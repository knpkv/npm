# jira-packages Code Review

**Date:** 2026-01-30
**Reviewer:** Claude Code
**Branch:** feature/jira-packages → main
**Files Changed:** 53

## Summary

Adds `@knpkv/jira-api-client`, `@knpkv/atlassian-common`, `@knpkv/jira-cli` packages. Refactors confluence packages to use shared common. Well-structured Effect-TS code with proper OAuth implementation.

**Issue counts:** P1: 1 | P2: 7 | P3: 2 | P4: 2 | Pre-existing: 2

**Main concerns:** Missing Buffer import, direct Node.js imports instead of Effect Platform, @ts-nocheck on generated code, silent error swallowing, type safety bypasses.

## Critical Issues (P1)

### Issue 1: Uses Node.js Buffer instead of Effect Platform encoding

**Severity:** P1 (Critical)
**File:** [packages/jira-api-client/src/JiraApiClient.ts#L81](../packages/jira-api-client/src/JiraApiClient.ts#L81)
**Summary:** Uses Node.js global `Buffer` instead of Effect Platform
**Details:** Basic auth encoding uses `Buffer.from(...).toString("base64")` but `Buffer` is a Node.js global. Breaks in non-Node environments and violates Effect Platform abstraction principles.
**Recommendation:** Use `@effect/platform` Encoding module for platform-independent base64
**Code Example:**
```typescript
// Before
const authHeader = config.auth.type === "basic"
  ? `Basic ${Buffer.from(`${config.auth.email}:${Redacted.value(config.auth.apiToken)}`).toString("base64")}`

// After - use Effect Platform Encoding
import * as Encoding from "@effect/platform/Encoding"

const credentials = `${config.auth.email}:${Redacted.value(config.auth.apiToken)}`
const encoded = Encoding.encodeBase64(new TextEncoder().encode(credentials))
const authHeader = config.auth.type === "basic"
  ? `Basic ${encoded}`
```

## High Priority (P2)

### Issue 2: Silent permission failures mask security issues

**Severity:** P2 (High)
**File:** [packages/atlassian-common/src/config/ConfigPaths.ts#L110](../packages/atlassian-common/src/config/ConfigPaths.ts#L110)
**Summary:** chmod/mkdir errors silently caught, insecure permissions undetected
**Details:** Both `ensureConfigDir` (L106,110) and `writeSecureFile` (L129-130,134-135) use `.catchAll(() => Effect.void)` to swallow all errors including permission failures. Token files could remain world-readable without warning.
**Recommendation:** Log warning or propagate error when secure permissions cannot be set
**Code Example:**
```typescript
// Before
yield* fs.chmod(configDir, 0o700).pipe(
  Effect.catchAll(() => Effect.void)
)

// After
yield* fs.chmod(configDir, 0o700).pipe(
  Effect.catchAll((err) =>
    Effect.logWarning(`Failed to set secure permissions on ${configDir}: ${err}`)
  )
)
```

### Issue 3: Invalid Date created from empty strings

**Severity:** P2 (High)
**File:** [packages/jira-cli/src/IssueService.ts#L216](../packages/jira-cli/src/IssueService.ts#L216)
**Summary:** `new Date("")` produces Invalid Date without error
**Details:** Comment and issue date fields use `new Date(String(field ?? ""))`. When field is null/undefined, creates `new Date("")` which returns Invalid Date. Downstream code may fail silently or produce "Invalid Date" in output.
**Recommendation:** Validate date string before construction or use fallback
**Code Example:**
```typescript
// Before
created: new Date(String(c["created"] ?? ""))

// After
const parseDate = (val: unknown): Date => {
  const str = String(val ?? "")
  const date = new Date(str)
  return isNaN(date.getTime()) ? new Date(0) : date
}
created: parseDate(c["created"])
```

### Issue 4: Comment/renderedComment array index mismatch

**Severity:** P2 (High)
**File:** [packages/jira-cli/src/IssueService.ts#L209](../packages/jira-cli/src/IssueService.ts#L209)
**Summary:** Assumes parallel array alignment without validation
**Details:** Maps `commentList` with index `i` to access `renderedComments[i]`. If Jira API returns different lengths (e.g., permissions hide some rendered comments), produces incorrect data mapping with no error.
**Recommendation:** Match by comment ID instead of array index
**Code Example:**
```typescript
// Before
const comments: Array<Comment> = commentList.map((c, i) => {
  const renderedBody = renderedComments[i]?.["body"]

// After
const renderedMap = new Map(
  renderedComments.map((r) => [String(r["id"]), r])
)
const comments: Array<Comment> = commentList.map((c) => {
  const rendered = renderedMap.get(String(c["id"]))
  const renderedBody = rendered?.["body"]
```

### Issue 5: Pagination loop has no iteration limit

**Severity:** P2 (High)
**File:** [packages/jira-cli/src/IssueService.ts#L309](../packages/jira-cli/src/IssueService.ts#L309)
**Summary:** `searchAll` could loop infinitely on API pagination bug
**Details:** While loop continues until `result.isLast` or no `nextPageToken`. If Jira API has bug returning same token repeatedly, loops forever without termination.
**Recommendation:** Add max iteration guard
**Code Example:**
```typescript
// Before
while (!result.isLast && result.nextPageToken) {

// After
const MAX_PAGES = 1000
let pageCount = 0
while (!result.isLast && result.nextPageToken && pageCount++ < MAX_PAGES) {
```

### Issue 6: Direct Node.js imports instead of Effect Platform

**Severity:** P2 (High)
**Files:**
- [packages/atlassian-common/src/config/ConfigPaths.ts#L40](../packages/atlassian-common/src/config/ConfigPaths.ts#L40)
- [packages/atlassian-common/src/config/ConfigPaths.ts#L59](../packages/atlassian-common/src/config/ConfigPaths.ts#L59)
- [packages/jira-cli/src/JiraAuth.ts#L172](../packages/jira-cli/src/JiraAuth.ts#L172)
- [packages/jira-cli/src/commands/auth.ts#L38](../packages/jira-cli/src/commands/auth.ts#L38)

**Summary:** Uses `process.env` and `process.platform` directly instead of Effect Platform
**Details:** Multiple files access Node.js globals directly:
- `process.env.HOME`, `process.env.USERPROFILE`, `process.env.XDG_CONFIG_HOME` for paths
- `process.platform` for OS detection

This breaks Effect's dependency injection, makes testing harder, and couples code to Node.js runtime.
**Recommendation:** Use `@effect/platform` abstractions for environment and platform detection
**Code Example:**
```typescript
// Before (ConfigPaths.ts)
get: () => Effect.sync(() => process.env.HOME ?? process.env.USERPROFILE ?? "/")
const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")

// After - inject via service
import * as Terminal from "@effect/platform/Terminal"

export class Environment extends Context.Tag("Environment")<
  Environment,
  { readonly get: (key: string) => Effect.Effect<string | undefined> }
>() {}

// Before (JiraAuth.ts)
const platform = process.platform

// After
import * as Platform from "@effect/platform/Platform"
const platform = yield* Platform.Platform
const os = platform.os // "darwin" | "linux" | "windows"
```

### Issue 7: @ts-nocheck disables 32K lines of type checking

**Severity:** P2 (High)
**File:** [packages/jira-api-client/src/generated/v3/Client.ts#L1](../packages/jira-api-client/src/generated/v3/Client.ts#L1)
**Summary:** Generated client bypasses all TypeScript type checking
**Details:** First line is `// @ts-nocheck` which disables all type errors in 32,593-line file. Combined with heavy `as any` usage (600+ occurrences), removes compile-time safety from API interactions. Not acceptable for production code.
**Recommendation:** Post-process generated code to remove @ts-nocheck and fix type errors, or switch to a generator that produces typed output.

### Issue 8: Home directory fallback to "/" is not acceptable

**Severity:** P2 (High)
**File:** [packages/atlassian-common/src/config/ConfigPaths.ts#L40](../packages/atlassian-common/src/config/ConfigPaths.ts#L40)
**Summary:** Returns "/" when HOME/USERPROFILE unset
**Details:** If neither HOME nor USERPROFILE exists, falls back to "/". Config would be written to `/.config/atlassian/` which is either inaccessible or system-wide. Not acceptable.
**Recommendation:** Fail with error when home directory cannot be determined
**Code Example:**
```typescript
// Before
get: () => Effect.sync(() => process.env.HOME ?? process.env.USERPROFILE ?? "/")

// After
get: () => Effect.sync(() => {
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) throw new Error("Cannot determine home directory: HOME/USERPROFILE not set")
  return home
})
```

## Medium Priority (P3)

### Issue 9: Type safety bypassed via `as unknown` casts

**Severity:** P3 (Medium)
**File:** [packages/jira-cli/src/IssueService.ts#L265](../packages/jira-cli/src/IssueService.ts#L265)
**Summary:** API response typed as `unknown` then cast, no validation
**Details:** Lines 265, 305, 315 use `bean as unknown as Record<string, unknown>` pattern. If API response shape changes, runtime errors occur instead of type errors.
**Recommendation:** Use Effect Schema to validate API response structure
**Code Example:**
```typescript
// Before
mappedIssues.push(mapIssue(bean as unknown as Record<string, unknown>, siteUrl))

// After - validate via schema or narrow type properly
const IssueBean = Schema.Struct({ key: Schema.String, id: Schema.String, fields: Schema.Unknown })
const decoded = Schema.decodeUnknownSync(IssueBean)(bean)
```

### Issue 10: JQL escaping incomplete

**Severity:** P3 (Medium)
**File:** [packages/jira-cli/src/internal/jqlBuilder.ts#L39](../packages/jira-cli/src/internal/jqlBuilder.ts#L39)
**Summary:** Only escapes quotes and backslashes, not newlines
**Details:** `escapeJqlValue` handles `"` and `\` but not newlines or other control characters. A version string with `\n` could inject additional JQL clauses.
**Recommendation:** Also escape newlines and carriage returns
**Code Example:**
```typescript
// Before
export const escapeJqlValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")

// After
export const escapeJqlValue = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
```

## Low Priority (P4)

### Issue 11: Minimal test coverage for jira-api-client

**Severity:** P4 (Low)
**File:** [packages/jira-api-client/test/JiraApiClient.test.ts](../packages/jira-api-client/test/JiraApiClient.test.ts)
**Summary:** Only 92 lines testing HTTP client mocking
**Details:** Tests verify layer construction but don't test actual API calls, error scenarios, auth header generation, or URL construction. Integration testing would catch auth/URL issues.
**Recommendation:** Add tests for auth header generation, base URL logic, and error mapping.

### Issue 12: No config validation in JiraApiConfig

**Severity:** P4 (Low)
**File:** [packages/jira-api-client/src/JiraApiConfig.ts](../packages/jira-api-client/src/JiraApiConfig.ts)
**Summary:** Config is plain interface with no runtime validation
**Details:** `baseUrl`, `email`, `cloudId`, `apiToken`, `accessToken` have no format validation. Invalid URLs or empty strings accepted.
**Recommendation:** Add Effect Schema validation for config fields.

## Pre-existing Issues

### Issue 13: Silent error catching in token storage

**Remark:** Pre-existing issue in atlassian-common, also used by confluence-to-markdown
**Severity:** P3 (Medium)
**File:** [packages/atlassian-common/src/config/TokenStorage.ts#L111](../packages/atlassian-common/src/config/TokenStorage.ts#L111)
**Summary:** `deleteToken` swallows all errors including permission denied
**Details:** Uses `.catchAll(() => Effect.void)` which hides failures like permission denied, disk full, etc.

### Issue 14: JSON parse error returns null silently

**Remark:** Pre-existing pattern in token storage
**Severity:** P4 (Low)
**File:** [packages/atlassian-common/src/config/TokenStorage.ts#L64](../packages/atlassian-common/src/config/TokenStorage.ts#L64)
**Summary:** Corrupted JSON returns null, no warning logged
**Details:** When auth.json is corrupted, silently returns null. User has no indication token file is malformed.

## Unresolved Questions

None - all clarified.

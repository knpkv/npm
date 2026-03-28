# @knpkv/atlassian-common

Shared utilities for Atlassian tools: OAuth2 + PKCE auth, token storage, config paths, AST types, and markdown serialization.

## Installation

```bash
pnpm add @knpkv/atlassian-common
```

## Subpath Exports

| Export                                | Contents                                     |
| ------------------------------------- | -------------------------------------------- |
| `@knpkv/atlassian-common`             | Everything (AST, auth, config, serializers)  |
| `@knpkv/atlassian-common/ast`         | Inline, block, macro, and document AST nodes |
| `@knpkv/atlassian-common/auth`        | OAuth2 endpoints, PKCE, token exchange       |
| `@knpkv/atlassian-common/config`      | Config paths, schemas, token storage         |
| `@knpkv/atlassian-common/serializers` | Markdown serializer for AST nodes            |

## OAuth2 + PKCE

Uses Web Crypto API (`globalThis.crypto`) — no `node:crypto` dependency. PKCE code verifier/challenge use `effect/Encoding` for base64url.

```typescript
import { Effect } from "effect"
import {
  generateCodeVerifier,
  computeCodeChallenge,
  buildAuthUrl,
  exchangeCodeForTokens,
  JIRA_SCOPES
} from "@knpkv/atlassian-common/auth"

const program = Effect.gen(function* () {
  // 1. Generate PKCE pair
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = yield* computeCodeChallenge(codeVerifier)

  // 2. Build authorization URL
  const url = buildAuthUrl({
    clientId: "your-client-id",
    state: "random-csrf-token",
    port: 8585,
    scopes: JIRA_SCOPES,
    codeChallenge
  })
  // → redirect user to `url`

  // 3. Exchange code for tokens (after callback)
  const tokens = yield* exchangeCodeForTokens({
    clientId: "your-client-id",
    clientSecret: "your-client-secret",
    code: "auth-code-from-callback",
    redirectUri: "http://localhost:8585/callback",
    codeVerifier
  })
  // tokens.access_token, tokens.refresh_token, tokens.expires_in
})
```

## Token Storage

Stores OAuth config and tokens in `~/.config/atlassian/` with 0600 permissions.

```typescript
import { Effect } from "effect"
import {
  saveToken,
  loadToken,
  isTokenExpired,
  saveOAuthConfig,
  loadOAuthConfig,
  HomeDirectoryLive
} from "@knpkv/atlassian-common/config"

const program = Effect.gen(function* () {
  yield* saveOAuthConfig({ clientId: "...", clientSecret: "..." }, "jira")
  const config = yield* loadOAuthConfig("jira")

  yield* saveToken({ access_token: "...", refresh_token: "...", expires_in: 3600 }, "jira")
  const token = yield* loadToken("jira")
  const expired = isTokenExpired(token)
}).pipe(Effect.provide(HomeDirectoryLive))
```

## AST Types

Typed Atlassian Document Format nodes — used by `@knpkv/jira-cli` and `@knpkv/confluence-to-markdown`.

```typescript
import { Document, Paragraph, Text, Heading, CodeBlock } from "@knpkv/atlassian-common/ast"
```

## Markdown Serializer

Converts AST nodes to markdown strings.

```typescript
import { serializeToMarkdown } from "@knpkv/atlassian-common/serializers"

const markdown = serializeToMarkdown(document)
```

## License

MIT

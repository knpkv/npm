import { strict } from "@effect/tsgo/oxlint-presets"
import { defineConfig } from "oxlint"

export default defineConfig({
  extends: [strict],
  ignorePatterns: [
    // Bytes are hash-pinned design exports, reviewed in ref PRs.
    "design-refs/*/screens/**",
    "design-refs/*/fixture.json",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    ".context/**",
    ".reference/**",
    ".pnpm-store/**",
    "**/dist/**",
    "**/docs/**",
    "**/generated/**",
    "repos/**",
    // Frozen external reference scripts are hash-verified inputs, not production source.
    "design-refs/code-review/screens/**",
    "design-refs/code-review/revisions/**/screens/**",
    "design-refs/review-canvas/revisions/**/screens/**",
    // design-sync inputs: forks of the converter's lib modules and story ports. Their bytes key
    // the claude.ai/design sync anchor, so a lint-driven rewrite re-grades every component.
    ".design-sync/overrides/**",
    ".design-sync/previews/**",
    "packages/*/.design-sync/overrides/**",
    "packages/*/.design-sync/previews/**",
    "tools/oxlint/anti-slop/**"
  ],
  jsPlugins: [
    {
      name: "anti-slop",
      specifier: "./tools/oxlint/anti-slop/index.ts"
    }
  ],
  overrides: [
    // Plain JavaScript has no parameter annotation for the rule to find.
    { files: ["**/*.mjs"], rules: { "effecttsgo/effect-fn-implicit-any": "off" } },
    // Negative type tests: `@ts-expect-error` proves the mismatch, the rule would report the same one.
    { files: ["**/dtslint/**"], rules: { "effecttsgo/missing-effect-error": "off" } }
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "effecttsgo/overridden-schema-constructor": "off",
    "effecttsgo/unstable-api-usage": "off",
    // `strict` makes every Effect rule an error. These still have findings: fix a rule's last one and
    // delete its line. This list only shrinks.
    "effecttsgo/abort-controller-in-effect": "warn",
    "effecttsgo/all-of-map-to-for-each": "warn",
    "effecttsgo/any-unknown-in-error-context": "warn",
    "effecttsgo/catch-all-to-map-error": "warn",
    "effecttsgo/catch-chain-to-first-success-of": "warn",
    "effecttsgo/catch-conditional-refail-to-catch-if": "warn",
    "effecttsgo/catch-if-tag-to-catch-tag": "warn",
    "effecttsgo/catch-refail-to-tap-error": "warn",
    "effecttsgo/catch-to-ignore": "warn",
    "effecttsgo/catch-to-or-else-succeed": "warn",
    "effecttsgo/effect-map-void": "warn",
    "effecttsgo/effect-succeed-with-undefined": "warn",
    "effecttsgo/error-payload-shadows-name": "warn",
    "effecttsgo/flat-map-conditional-to-filter-or-fail": "warn",
    "effecttsgo/flat-map-to-map": "warn",
    "effecttsgo/flat-map-to-tap": "warn",
    "effecttsgo/global-error-in-effect-catch": "warn",
    "effecttsgo/global-error-in-effect-failure": "warn",
    "effecttsgo/lazy-effect": "warn",
    "effecttsgo/map-const-to-as": "warn",
    "effecttsgo/map-some-to-as-some": "warn",
    "effecttsgo/match-to-result-or-option": "warn",
    "effecttsgo/multiple-catch-tag": "warn",
    "effecttsgo/multiple-effect-provide": "warn",
    "effecttsgo/option-match-to-from-option": "warn",
    "effecttsgo/prefer-succeed-some-or-none": "warn",
    "effecttsgo/prefer-typed-schema-decoder": "warn",
    "effecttsgo/prefer-unsafe-constructor": "warn",
    "effecttsgo/provide-layer-succeed-to-provide-service": "warn",
    "effecttsgo/race-first-with-sleep-to-timeout": "warn",
    "effecttsgo/redundant-map-error": "warn",
    "effecttsgo/run-effect-inside-effect": "warn",
    "effecttsgo/run-of-exit-to-run-exit": "warn",
    "effecttsgo/schema-class-missing-brand": "warn",
    "effecttsgo/schema-class-object-literal": "warn",
    "effecttsgo/schema-number": "warn",
    "effecttsgo/schema-struct-with-tag": "warn",
    "effecttsgo/schema-sync-in-effect": "warn",
    "effecttsgo/sync-to-succeed": "warn",
    "effecttsgo/timeout-catch-tag-to-timeout-or-else": "warn",
    "effecttsgo/unknown-in-effect-catch": "warn",
    "effecttsgo/unnecessary-effect-gen": "warn",
    "effecttsgo/unnecessary-fail-yieldable-error": "warn",
    "effecttsgo/unnecessary-pipe-chain": "warn",
    "effecttsgo/unnecessary-typeof-type": "warn",
    "typescript/no-floating-promises": [
      "error",
      {
        // Fire-and-forget by design: the runner collects `test()`, and the router owns navigation.
        allowForKnownSafeCalls: [
          { from: "package", name: "test", package: "node:test" },
          { from: "package", name: "NavigateFunction", package: "react-router" }
        ]
      }
    ]
  }
})

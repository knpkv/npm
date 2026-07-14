import { describe, expect, it } from "vitest"
import { declaredRlyCssTokens, inspectRlyCssTokens } from "../../scripts/rlyCssTokens.js"

const generatedTokens = declaredRlyCssTokens(`
  :root {
    --rly-radius-group: 1.5rem;
    --rly-space-8: 0.5rem;
  }
`)

describe("Control Center rly CSS token validation", () => {
  it("rejects the original unresolved EntityShell grouped-radius reference", () => {
    expect(
      inspectRlyCssTokens(
        "packages/rly/src/patterns/EntityShell.module.css",
        ".root { border-radius: var(--rly-radius-grouped); }",
        generatedTokens
      )
    ).toEqual([
      {
        column: 24,
        line: 1,
        sourcePath: "packages/rly/src/patterns/EntityShell.module.css",
        token: "--rly-radius-grouped"
      }
    ])
  })

  it("accepts generated, unconditional root, same-rule, registered, and fallback definitions", () => {
    const source = `
      @property --rly-registered-local {
        syntax: "<length>";
        initial-value: 1rem;
        inherits: false;
      }
      :root { --rly-module-local: 2rem; }
      .valid {
        --rly-same-rule: 3rem;
        border-radius: var(--rly-radius-group);
        gap: var(--rly-module-local);
        margin: var(--rly-registered-local);
        padding: var(--rly-optional-space, var(--rly-space-8));
        scroll-margin: var(--rly-same-rule);
      }
    `

    expect(inspectRlyCssTokens("src/client/example.module.css", source, generatedTokens)).toEqual([])
  })

  it("does not let a declaration in a sibling selector resolve a reference", () => {
    const source = `.owner { --rly-private: red; }
.consumer { color: var(--rly-private); }`

    expect(inspectRlyCssTokens("packages/rly/src/sibling.module.css", source, generatedTokens)).toEqual([
      {
        column: 20,
        line: 2,
        sourcePath: "packages/rly/src/sibling.module.css",
        token: "--rly-private"
      }
    ])
  })

  it.each([
    ["missing", "syntax: \"<length>\"; inherits: false;"],
    ["empty", "syntax: \"<length>\"; inherits: false; initial-value:;"],
    ["comment-only", "syntax: \"<length>\"; inherits: false; initial-value: /* unavailable */;"],
    ["missing-syntax", "inherits: false; initial-value: 1rem;"],
    ["invalid-syntax", "syntax: <length>; inherits: false; initial-value: 1rem;"],
    ["missing-inherits", "syntax: \"<length>\"; initial-value: 1rem;"]
  ])("rejects an unusable %s @property registration", (_, descriptors) => {
    const source = `
      @property --rly-unusable { ${descriptors} }
      .consumer { margin: var(--rly-unusable); }
    `

    expect(inspectRlyCssTokens("packages/rly/src/property.module.css", source, generatedTokens)).toEqual([
      expect.objectContaining({ sourcePath: "packages/rly/src/property.module.css", token: "--rly-unusable" })
    ])
  })

  it("accepts a complete @property registration with a quoted initial value", () => {
    const source = `
      @property --rly-label {
        syntax: "<string>";
        inherits: false;
        initial-value: "ready";
      }
      .consumer { content: var(--rly-label); }
    `

    expect(inspectRlyCssTokens("packages/rly/src/property.module.css", source, generatedTokens)).toEqual([])
  })

  it("ignores token-shaped text in comments and strings", () => {
    const source = `
      /* gap: var(--rly-comment-only); */
      .example::before { content: "var(--rly-string-only)"; }
    `

    expect(inspectRlyCssTokens("src/client/example.module.css", source, generatedTokens)).toEqual([])
  })

  it("still validates nested fallback references", () => {
    const source = ".example { gap: var(--rly-optional, var(--rly-nested-typo)); }"

    expect(inspectRlyCssTokens("src/client/example.module.css", source, generatedTokens)).toEqual([
      {
        column: 37,
        line: 1,
        sourcePath: "src/client/example.module.css",
        token: "--rly-nested-typo"
      }
    ])
  })
})

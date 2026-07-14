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

  it("accepts generated, unconditional root, same-rule, and fallback definitions", () => {
    const source = `
      :root { --rly-module-local: 2rem; }
      .valid {
        --rly-same-rule: 3rem;
        border-radius: var(--rly-radius-group);
        gap: var(--rly-module-local);
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
    ["complete-looking", "@property --rly-registered { syntax: \"<length>\"; inherits: false; initial-value: 1px; }"],
    ["syntax mismatch", "@property --rly-registered { syntax: \"<length>\"; inherits: false; initial-value: red; }"],
    [
      "relative initial value",
      "@property --rly-registered { syntax: \"<length>\"; inherits: false; initial-value: 1rem; }"
    ],
    [
      "malformed syntax",
      "@property --rly-registered { syntax: \"<length>\" junk \"\"; inherits: false; initial-value: 1px; }"
    ],
    [
      "duplicate registrations",
      `@property --rly-registered { syntax: "<length>"; inherits: false; initial-value: 1px; }
       @property --rly-registered { syntax: "*"; inherits: false; initial-value: red; }`
    ]
  ])("does not let a %s @property registration suppress a violation", (_, registration) => {
    const source = `
      ${registration}
      .consumer { margin: var(--rly-registered); }
    `

    expect(declaredRlyCssTokens(source)).not.toContain("--rly-registered")
    expect(inspectRlyCssTokens("packages/rly/src/property.module.css", source, generatedTokens)).toEqual([
      expect.objectContaining({ sourcePath: "packages/rly/src/property.module.css", token: "--rly-registered" })
    ])
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

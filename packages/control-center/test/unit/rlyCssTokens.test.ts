import { describe, expect, it } from "vitest"
import { declaredRlyCssTokens, inspectRlyCssTokens } from "../../scripts/rlyCssTokens.js"

const generatedTokens = declaredRlyCssTokens(`
  :root {
    --rly-radius-group: 1.5rem;
    --rly-space-8: 0.5rem;
  }
`)

describe("Control Center rly CSS token validation", () => {
  it("rejects the original unresolved grouped-radius reference", () => {
    expect(
      inspectRlyCssTokens(
        "src/client/portfolio/PortfolioOverview.module.css",
        ".releaseList { border-radius: var(--rly-radius-grouped); }",
        generatedTokens
      )
    ).toEqual([
      {
        column: 31,
        line: 1,
        sourcePath: "src/client/portfolio/PortfolioOverview.module.css",
        token: "--rly-radius-grouped"
      }
    ])
  })

  it("accepts generated tokens, local declarations, registrations, and explicit fallbacks", () => {
    const source = `
      @property --rly-registered-local {
        syntax: "<length>";
        initial-value: 1rem;
        inherits: false;
      }
      :root { --rly-module-local: 2rem; }
      .valid {
        border-radius: var(--rly-radius-group);
        gap: var(--rly-module-local);
        margin: var(--rly-registered-local);
        padding: var(--rly-optional-space, var(--rly-space-8));
      }
    `

    expect(inspectRlyCssTokens("src/client/example.module.css", source, generatedTokens)).toEqual([])
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

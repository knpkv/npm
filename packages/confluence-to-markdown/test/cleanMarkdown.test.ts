import { describe, expect, it } from "@effect/vitest"
import { cleanMarkdown } from "../src/internal/cleanMarkdown.js"

describe("cleanMarkdown", () => {
  it("removes full-line ADF metadata comments", () => {
    const markdown = [
      "# Title",
      "",
      "<!-- adf:panel type=info attrs={} -->",
      "",
      "Body",
      "",
      "<!-- adf:/panel -->"
    ].join("\n")

    expect(cleanMarkdown(markdown)).toBe("# Title\n\nBody\n")
  })

  it("removes inline ADF metadata comments", () => {
    expect(cleanMarkdown("Card <!-- adf:inlineCard attrs={} --> text")).toBe("Card  text\n")
  })

  it("keeps regular markdown, native macros, status spans, and non-ADF comments", () => {
    const markdown = [
      "[[toc]]",
      "",
      '<span data-adf-status="todo" data-adf-color="blue">TODO</span>',
      "",
      "<!-- keep this comment -->",
      "",
      "- item"
    ].join("\n")

    expect(cleanMarkdown(markdown)).toBe(`${markdown}\n`)
  })
})

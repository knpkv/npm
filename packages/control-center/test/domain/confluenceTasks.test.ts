import { describe, expect, it } from "vitest"

import { confluenceTasks, confluenceTaskSummary, setConfluenceTaskChecked } from "../../src/domain/confluenceTasks.js"

describe("Confluence release tasks", () => {
  it("counts Markdown and compact Confluence checkboxes", () => {
    const markdown = [
      "## Release checks",
      "- [ ] Run smoke tests",
      "* [x] Attach the report",
      "[] Record the verbal risk assessment",
      "1. [X] Confirm Stage approval"
    ].join("\n")

    expect(confluenceTaskSummary(markdown)).toEqual(expect.objectContaining({
      completed: 2,
      outstanding: 2,
      total: 4
    }))
    expect(confluenceTasks(markdown).map(({ label }) => label)).toEqual([
      "Run smoke tests",
      "Attach the report",
      "Record the verbal risk assessment",
      "Confirm Stage approval"
    ])
  })

  it("ignores checkbox examples in fenced code and ordinary inline prose", () => {
    const markdown = [
      "Use [ ] in prose as an example.",
      "```md",
      "- [ ] This is an example",
      "```",
      "- [ ] This is release work"
    ].join("\n")

    expect(confluenceTasks(markdown)).toEqual([expect.objectContaining({
      label: "This is release work",
      lineNumber: 5
    })])
  })

  it("does not close a fenced example when text follows the marker", () => {
    const markdown = [
      "```md",
      "````not-a-close",
      "- [ ] Still example content",
      "````   ",
      "- [ ] Real release work"
    ].join("\n")

    expect(confluenceTasks(markdown)).toEqual([expect.objectContaining({
      label: "Real release work",
      lineNumber: 5
    })])
  })

  it("ticks only the selected line and preserves the document", () => {
    const markdown = "- [ ] Test report\n- [x] Release notes"

    expect(setConfluenceTaskChecked(markdown, 0, true)).toBe(
      "- [x] Test report\n- [x] Release notes"
    )
    expect(setConfluenceTaskChecked(markdown, 8, true)).toBeNull()
  })

  it("counts and ticks task markers escaped by the safe Confluence projection", () => {
    const markdown = "- \\[ \\] Stage approval\n- \\[x\\] Risk sign-off"

    expect(confluenceTaskSummary(markdown)).toEqual(expect.objectContaining({
      completed: 1,
      outstanding: 1,
      total: 2
    }))
    expect(setConfluenceTaskChecked(markdown, 0, true)).toBe(
      "- \\[x\\] Stage approval\n- \\[x\\] Risk sign-off"
    )
  })
})

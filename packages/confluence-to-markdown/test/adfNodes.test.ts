import { describe, expect, it } from "@effect/vitest"
import { applyAdfTemplate } from "../src/commands/adfPage.js"
import {
  adfNodeCensus,
  deleteAdfNodes,
  parseNodeSelector,
  replaceAdfText,
  roundTripUnsafeNodeTypes,
  structuralCensusDelta,
  walkAdf
} from "../src/internal/adfNodes.js"

const datasourceCard = {
  type: "blockCard",
  attrs: {
    datasource: {
      id: "d8b75300-dfda-4519-b6cd-e49abbd50401",
      parameters: { cloudId: "cloud-1", jql: `fixVersion = "REL 96"` }
    },
    url: "https://example.atlassian.net/issues/?jql=fixVersion"
  }
}

const doc = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "expand",
      attrs: { title: "Issues in this release" },
      content: [datasourceCard, { type: "paragraph" }]
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "The alarm is " },
        { type: "text", text: "built but parked", marks: [{ type: "strong" }] },
        { type: "text", text: " so it still fires." }
      ]
    }
  ]
}

describe("adfNodeCensus", () => {
  it("counts every node by type", () => {
    expect(adfNodeCensus(doc)).toEqual({
      doc: 1,
      expand: 1,
      blockCard: 1,
      paragraph: 2,
      text: 3
    })
  })

  it("ignores non-nodes", () => {
    expect(adfNodeCensus(null)).toEqual({})
    expect(adfNodeCensus({ notANode: true })).toEqual({})
  })
})

describe("structuralCensusDelta", () => {
  it("is empty when only prose changes", () => {
    const edited = replaceAdfText(doc, "still fires", "no longer fires").doc

    expect(structuralCensusDelta(doc, edited)).toEqual([])
  })

  // The exact shape of the round-trip duplication bug: a second copy of the
  // datasource card appears alongside the original.
  it("reports a duplicated block card", () => {
    const duplicated = { ...doc, content: [...doc.content, datasourceCard] }

    expect(structuralCensusDelta(doc, duplicated)).toEqual([
      { type: "blockCard", before: 1, after: 2 }
    ])
  })

  it("reports a dropped expand", () => {
    const stripped = { ...doc, content: doc.content.slice(1) }

    expect(structuralCensusDelta(doc, stripped)).toEqual([
      { type: "blockCard", before: 1, after: 0 },
      { type: "expand", before: 1, after: 0 }
    ])
  })
})

describe("roundTripUnsafeNodeTypes", () => {
  // A datasource card at block level goes through `encodedBlockNode`, which
  // carries the whole node — datasource attrs included — in its open marker.
  // `RoundTripFixpoint.test.ts` runs this exact document through the converter
  // and gets it back unchanged, so refusing to push it was a false alarm.
  it("does not flag a datasource block card that the marker carries", () => {
    expect(roundTripUnsafeNodeTypes(doc)).toEqual([])
  })

  it("does not flag a plain link card", () => {
    const plain = { type: "doc", content: [{ type: "blockCard", attrs: { url: "https://example.com" } }] }

    expect(roundTripUnsafeNodeTypes(plain)).toEqual([])
  })

  it("accepts a card whose url only lives under attrs.data, as the walker does", () => {
    const viaData = {
      type: "doc",
      content: [{ type: "embedCard", attrs: { data: { url: "https://example.com/board" } } }]
    }

    expect(roundTripUnsafeNodeTypes(viaData)).toEqual([])
  })

  // No url means the walker never reaches `encodedBlockNode`: it emits
  // `<!-- unsupported ADF node: blockCard -->` and the node is lost.
  it("flags a card with no resolvable url", () => {
    const urlless = {
      type: "doc",
      content: [{ type: "blockCard", attrs: { datasource: { id: "d-1" } } }]
    }

    expect(roundTripUnsafeNodeTypes(urlless)).toEqual(["blockCard"])
  })

  // A cell renders the card as a bare link, but the enclosing table carries
  // every descendant in its own marker, so the card comes back whole. Being in
  // a table is not on its own a reason to refuse the push.
  it("does not flag a card inside a table, which the table's marker carries", () => {
    const inCell = {
      type: "doc",
      content: [{
        type: "table",
        content: [{
          type: "tableRow",
          content: [{ type: "tableCell", content: [datasourceCard] }]
        }]
      }]
    }

    expect(roundTripUnsafeNodeTypes(inCell)).toEqual([])
  })

  it("does not flag macros the attrs marker round-trips", () => {
    const macro = {
      type: "doc",
      content: [
        { type: "extension", attrs: { extensionKey: "toc" } },
        { type: "bodiedExtension", attrs: { extensionKey: "excerpt" }, content: [{ type: "paragraph" }] },
        { type: "inlineExtension", attrs: { extensionKey: "status" } }
      ]
    }

    expect(roundTripUnsafeNodeTypes(macro)).toEqual([])
  })

  it("flags a bodiedExtension inside a table, whose body the walker drops", () => {
    const inCell = {
      type: "doc",
      content: [{
        type: "table",
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            content: [{ type: "bodiedExtension", attrs: { extensionKey: "excerpt" } }]
          }]
        }]
      }]
    }

    expect(roundTripUnsafeNodeTypes(inCell)).toEqual(["bodiedExtension"])
  })

  it("flags multiBodiedExtension, which the walker has no case for", () => {
    const macro = { type: "doc", content: [{ type: "multiBodiedExtension", attrs: { extensionKey: "tabs" } }] }

    expect(roundTripUnsafeNodeTypes(macro)).toEqual(["multiBodiedExtension"])
  })
})

describe("replaceAdfText", () => {
  it("rewrites matching text nodes and counts occurrences", () => {
    const result = replaceAdfText(doc, "still fires", "no longer fires")

    expect(result.replacements).toBe(1)
    expect(JSON.stringify(result.doc)).toContain("so it no longer fires")
  })

  it("preserves marks on the nodes it rewrites", () => {
    const result = replaceAdfText(doc, "built but parked", "not yet shipped")

    const rewritten: Array<unknown> = []
    walkAdf(result.doc, (node) => {
      if (node.type === "text" && node.text === "not yet shipped") rewritten.push(node)
    })

    expect(rewritten).toEqual([{
      type: "text",
      text: "not yet shipped",
      marks: [{ type: "strong" }]
    }])
  })

  it("leaves the document untouched when nothing matches", () => {
    // A phrase spanning a mark boundary lives in separate text nodes, so it
    // cannot match — reported as zero rather than rewritten across the split.
    const result = replaceAdfText(doc, "alarm is built", "x")

    expect(result.replacements).toBe(0)
    expect(result.doc).toEqual(doc)
  })
})

describe("parseNodeSelector", () => {
  it("parses a bare type", () => {
    expect(parseNodeSelector("blockCard")).toEqual({ type: "blockCard" })
  })

  it("parses an indexed type", () => {
    expect(parseNodeSelector("blockCard[1]")).toEqual({ type: "blockCard", index: 1 })
  })

  it("rejects malformed selectors", () => {
    expect(parseNodeSelector("block card")).toBeNull()
    expect(parseNodeSelector("blockCard[x]")).toBeNull()
    expect(parseNodeSelector("[0]")).toBeNull()
  })
})

describe("deleteAdfNodes", () => {
  const withStray = { ...doc, content: [...doc.content, datasourceCard] }

  it("deletes a single indexed occurrence", () => {
    const result = deleteAdfNodes(withStray, { type: "blockCard", index: 1 })

    expect(result.deleted).toBe(1)
    expect(adfNodeCensus(result.doc).blockCard).toBe(1)
    // The surviving card is the one nested in the expand.
    expect(structuralCensusDelta(doc, result.doc)).toEqual([])
  })

  it("deletes every occurrence when no index is given", () => {
    const result = deleteAdfNodes(withStray, { type: "blockCard" })

    expect(result.deleted).toBe(2)
    expect(adfNodeCensus(result.doc).blockCard).toBeUndefined()
  })

  it("reports zero when nothing matches", () => {
    const result = deleteAdfNodes(doc, { type: "panel" })

    expect(result.deleted).toBe(0)
    expect(result.doc).toEqual(doc)
  })
})

describe("applyAdfTemplate", () => {
  it("fills every occurrence of a slot", () => {
    const raw = `{"jql":"fixVersion = \\"{{release}}\\"","text":"{{release}} notes"}`

    const { rendered, unresolved } = applyAdfTemplate(raw, new Map([["release", "REL 96"]]))

    expect(JSON.parse(rendered)).toEqual({ jql: `fixVersion = "REL 96"`, text: "REL 96 notes" })
    expect(unresolved).toEqual([])
  })

  // A release name with a quote in it must not be able to break the document.
  it("JSON-escapes substituted values", () => {
    const raw = `{"text":"{{title}}"}`

    const { rendered } = applyAdfTemplate(raw, new Map([["title", `He said "hi"\\bye`]]))

    expect(JSON.parse(rendered)).toEqual({ text: `He said "hi"\\bye` })
  })

  // Scanning the rendered text could not tell a slot the author wrote from
  // brace-brace text inside a substituted value, so a legitimate title failed
  // the command with "still has unfilled slots" for a slot nobody declared.
  it("does not treat braces inside a substituted value as a slot", () => {
    const raw = `{"title":"{{release}}"}`

    const { rendered, unresolved } = applyAdfTemplate(raw, new Map([["release", "Use {{status}} macro"]]))

    expect(JSON.parse(rendered)).toEqual({ title: "Use {{status}} macro" })
    expect(unresolved).toEqual([])
  })

  // The same text with `status` also filled: substituting values in turn
  // re-scanned what an earlier one introduced, so one value could inject
  // another's substitution and the document said something the user never
  // passed.
  it("does not substitute into text an earlier value introduced", () => {
    const raw = `{"title":"{{release}}","state":"{{status}}"}`

    const { rendered, unresolved } = applyAdfTemplate(
      raw,
      new Map([["release", "Use {{status}} macro"], ["status", "done"]])
    )

    expect(JSON.parse(rendered)).toEqual({ title: "Use {{status}} macro", state: "done" })
    expect(unresolved).toEqual([])
  })

  it("reports slots nobody filled", () => {
    const raw = `{"a":"{{release}}","b":"{{dateMs}}","c":"{{dateMs}}"}`

    const { unresolved } = applyAdfTemplate(raw, new Map([["release", "REL 96"]]))

    expect(unresolved).toEqual(["dateMs"])
  })
})

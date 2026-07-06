import { describe, expect, it } from "@effect/vitest"
import { collectAdfMetadataHrefs, externalizeAdfMetadata, hydrateAdfMetadata } from "../src/internal/adfMetadata.js"

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  return btoa(String.fromCharCode(...bytes))
}

describe("ADF metadata sidecars", () => {
  it("moves decoded placeholder metadata into a linked sidecar", () => {
    const markdown = [
      `<!-- adf:panel type=info attrs={"panelType":"info"} -->`,
      "",
      "Body",
      "",
      "<!-- adf:/panel -->",
      "",
      `Regular link: <!-- adf:inlineCard attrs={"url":"https://www.atlassian.com"} -->.`
    ].join("\n")

    const prepared = externalizeAdfMetadata(markdown, "./123.adf.json")

    expect(prepared.markdown).toContain("<!-- adf:panel type=info ref=./123.adf.json#panel-1 -->")
    expect(prepared.markdown).toContain("<!-- adf:inlineCard ref=./123.adf.json#inlineCard-2 -->")
    expect(prepared.markdown).not.toContain("attrs={")
    expect(prepared.sidecar).toEqual({
      version: 1,
      entries: {
        "panel-1": {
          kind: "attrs",
          value: { panelType: "info" }
        },
        "inlineCard-2": {
          kind: "attrs",
          value: { url: "https://www.atlassian.com" }
        }
      }
    })
  })

  it("moves base64 placeholder metadata into a linked sidecar", () => {
    const attrs = {
      extensionKey: "toc",
      extensionType: "com.atlassian.confluence.macro.core",
      parameters: {
        macroMetadata: {
          title: "Table of Contents"
        }
      }
    }
    const encodedAttrs = toBase64(JSON.stringify(attrs))
    const markdown =
      `| **On this page** | <!-- adf:extension key=toc type=com.atlassian.confluence.macro.core attrs=${encodedAttrs} --> |`

    const prepared = externalizeAdfMetadata(markdown, "./2731114497.adf.json")

    expect(prepared.markdown).toBe(
      "| **On this page** | <!-- adf:extension key=toc type=com.atlassian.confluence.macro.core ref=./2731114497.adf.json#extension-1 --> |"
    )
    expect(prepared.markdown).not.toContain(encodedAttrs)
    expect(prepared.sidecar).toEqual({
      version: 1,
      entries: {
        "extension-1": {
          kind: "attrs",
          value: attrs
        }
      }
    })
  })

  it("moves codeBlock node metadata into a linked sidecar", () => {
    const node = {
      attrs: { language: "json", localId: "14686791bf5e" },
      content: [{
        text: [
          "{",
          "  \"pageType\": \"integration-test-asset\",",
          "  \"mentions\": [\"[Add Engineer]\", \"[Add Reviewer]\"],",
          "  \"supportsADF\": true",
          "}"
        ].join("\n"),
        type: "text"
      }],
      marks: [{ attrs: { mode: "wide", width: 1011 }, type: "breakout" }],
      type: "codeBlock"
    }
    const markdown = [
      `<!-- adf:codeBlock node=${JSON.stringify(node)} -->`,
      "",
      "```json",
      node.content[0]!.text,
      "```",
      "",
      "<!-- adf:/codeBlock -->"
    ].join("\n")

    const prepared = externalizeAdfMetadata(markdown, "./2031617.adf.json")

    expect(prepared.markdown).toContain("<!-- adf:codeBlock ref=./2031617.adf.json#codeBlock-1 -->")
    expect(prepared.markdown).not.toContain("node={")
    expect(prepared.sidecar?.entries["codeBlock-1"]).toEqual({
      kind: "node",
      value: node
    })
  })

  it("hydrates linked sidecar metadata back into placeholders for push", () => {
    const markdown = `<!-- adf:taskList ref=./123.adf.json#taskList-1 -->`
    const hydrated = hydrateAdfMetadata(
      markdown,
      new Map([
        [
          "./123.adf.json",
          {
            version: 1,
            entries: {
              "taskList-1": {
                kind: "node",
                value: {
                  type: "taskList",
                  attrs: { localId: "task-list" },
                  content: [{ type: "taskItem", attrs: { state: "DONE" } }]
                }
              }
            }
          }
        ]
      ])
    )

    // The blob is base64-encoded so the @atlaskit markdown parser can't split
    // the placeholder comment on markdown-active characters in the JSON payload.
    const match = /<!-- adf:taskList node=(\S+) -->/.exec(hydrated)
    expect(match).not.toBeNull()
    expect(match![1]).not.toContain("{")
    expect(Buffer.from(match![1]!, "base64").toString("utf8")).toBe(
      `{"attrs":{"localId":"task-list"},"content":[{"attrs":{"state":"DONE"},"type":"taskItem"}],"type":"taskList"}`
    )
  })

  it("collects each referenced sidecar href once", () => {
    const hrefs = collectAdfMetadataHrefs([
      "<!-- adf:panel ref=./123.adf.json#panel-1 -->",
      "<!-- adf:taskList ref=./123.adf.json#taskList-2 -->",
      "<!-- adf:panel ref=./456.adf.json#panel-1 -->"
    ].join("\n"))

    expect([...hrefs].sort()).toEqual(["./123.adf.json", "./456.adf.json"])
  })
})

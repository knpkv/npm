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

    expect(hydrated).toBe(
      `<!-- adf:taskList node={"attrs":{"localId":"task-list"},"content":[{"attrs":{"state":"DONE"},"type":"taskItem"}],"type":"taskList"} -->`
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

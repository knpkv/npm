import { describe, expect, it } from "vitest"

import { makeConfluenceTemplateLoader } from "../../src/client/releases/confluenceTemplateTransport.js"
import type { DeliveryEntityProjection } from "../../src/domain/deliveryGraph.js"
import { EntityId } from "../../src/domain/identifiers.js"
import { releaseWorksetFixture } from "../fixtures/releaseWorkset.js"

const pageProjection = releaseWorksetFixture.entityProjections.find(
  ({ projection }) => projection.details._tag === "page"
)?.projection

if (pageProjection?.details._tag !== "page") {
  throw new Error("Expected the release workset fixture to contain a Confluence page")
}
const pageRevision = pageProjection.details.revision

const summarizedPage = {
  ...pageProjection,
  title: "Payments release template",
  details: {
    ...pageProjection.details,
    content: null,
    contentState: "lazy"
  }
} satisfies DeliveryEntityProjection

const exactPage = {
  ...pageProjection,
  title: "Payments release template",
  details: {
    ...pageProjection.details,
    content: {
      representation: "safe-markdown",
      markdown: "## Release template\n\nUse the current release evidence."
    },
    contentState: "loaded"
  }
} satisfies DeliveryEntityProjection

describe("Confluence template transport", () => {
  it("hydrates exact content instead of treating the summarized page body as a template", async () => {
    const loadedEntityIds: Array<string> = []
    const load = makeConfluenceTemplateLoader({
      list: async () => [summarizedPage],
      load: async (entityId) => {
        loadedEntityIds.push(entityId)
        return exactPage
      }
    })

    const templates = await load(new AbortController().signal)

    expect(loadedEntityIds).toEqual([pageProjection.entityId])
    expect(templates).toEqual([{
      entityId: pageProjection.entityId,
      markdown: "## Release template\n\nUse the current release evidence.",
      revision: pageRevision,
      title: "Payments release template"
    }])
  })

  it("classifies templates before applying the bounded hydration limit", async () => {
    const templateEntityId = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000099")
    const nonTemplates = Array.from({ length: 55 }, (_, index) => ({
      ...summarizedPage,
      entityId: EntityId.make(`01890f6f-6d6a-7cc0-98d3-${String(index + 1).padStart(12, "0")}`),
      title: `Release notes ${String(index + 1)}`
    }))
    const load = makeConfluenceTemplateLoader({
      list: async () => [
        ...nonTemplates,
        { ...summarizedPage, entityId: templateEntityId, title: "Components release template" }
      ],
      load: async (entityId) => ({
        ...exactPage,
        entityId,
        title: "Components release template"
      })
    })

    const templates = await load(new AbortController().signal)

    expect(templates).toEqual([expect.objectContaining({
      entityId: templateEntityId,
      title: "Components release template"
    })])
  })
})

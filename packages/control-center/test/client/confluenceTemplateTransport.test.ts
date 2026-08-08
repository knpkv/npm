import { describe, expect, it } from "vitest"

import { makeConfluenceTemplateLoader } from "../../src/client/releases/confluenceTemplateTransport.js"
import type { DeliveryEntityProjection } from "../../src/domain/deliveryGraph.js"
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
  details: {
    ...pageProjection.details,
    content: null,
    contentState: "lazy"
  }
} satisfies DeliveryEntityProjection

const exactPage = {
  ...pageProjection,
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
      title: pageProjection.title
    }])
  })
})

import type { DeliveryEntityProjection } from "../../domain/deliveryGraph.js"
import type { EntityId } from "../../domain/identifiers.js"
import { browserWorkspaceEntityTransport } from "../entities/useWorkspaceEntity.js"
import { browserWorkspaceItemsTransport } from "../items/useWorkspaceItems.js"

const MAXIMUM_CONFLUENCE_TEMPLATES = 50
const CONFLUENCE_TEMPLATE_BATCH_SIZE = 8

export interface ConfluenceReleaseTemplate {
  readonly entityId: EntityId
  readonly markdown: string
  readonly revision: string
  readonly title: string
}

export type ConfluenceTemplateLoader = (
  signal: AbortSignal
) => Promise<ReadonlyArray<ConfluenceReleaseTemplate>>

export interface ConfluenceTemplateSource {
  readonly list: (signal: AbortSignal) => Promise<ReadonlyArray<DeliveryEntityProjection>>
  readonly load: (entityId: EntityId, signal: AbortSignal) => Promise<DeliveryEntityProjection>
}

const templateFor = (projection: DeliveryEntityProjection): ConfluenceReleaseTemplate | null => {
  const details = projection.details
  return projection.entityState === "present" &&
      details._tag === "page" &&
      details.contentState === "loaded" &&
      details.content?.markdown !== undefined &&
      details.content.markdown.trim().length > 0
    ? {
      entityId: projection.entityId,
      markdown: details.content.markdown,
      revision: details.revision,
      title: projection.title
    }
    : null
}

const orderTemplates = (
  templates: ReadonlyArray<ConfluenceReleaseTemplate>
): ReadonlyArray<ConfluenceReleaseTemplate> =>
  [...templates].sort((left, right) => {
    const leftTemplate = /\btemplate\b/iu.test(left.title) ? 0 : 1
    const rightTemplate = /\btemplate\b/iu.test(right.title) ? 0 : 1
    return leftTemplate - rightTemplate || left.title.localeCompare(right.title)
  })

const isTemplateSummary = (projection: DeliveryEntityProjection): boolean =>
  projection.entityState === "present" &&
  projection.details._tag === "page" &&
  /\btemplate\b/iu.test(projection.title)

/**
 * Hydrate exact page projections behind the summarized workspace index.
 *
 * The Items boundary deliberately removes document bodies, so template content
 * must come from the existing exact-entity read instead of the summary payload.
 */
export const makeConfluenceTemplateLoader = (
  source: ConfluenceTemplateSource
): ConfluenceTemplateLoader => {
  return async (signal) => {
    const summaries = (await source.list(signal)).filter(isTemplateSummary).slice(0, MAXIMUM_CONFLUENCE_TEMPLATES)
    const templates: Array<ConfluenceReleaseTemplate> = []
    for (let offset = 0; offset < summaries.length; offset += CONFLUENCE_TEMPLATE_BATCH_SIZE) {
      const batch = summaries.slice(offset, offset + CONFLUENCE_TEMPLATE_BATCH_SIZE)
      const projections = await Promise.all(
        batch.map(({ entityId }) => source.load(entityId, signal))
      )
      for (const projection of projections) {
        const template = templateFor(projection)
        if (template !== null) templates.push(template)
      }
    }
    return orderTemplates(templates)
  }
}

export const loadBrowserConfluenceTemplates = makeConfluenceTemplateLoader({
  list: async (signal) => {
    const index = await browserWorkspaceItemsTransport.load(signal, {
      owner: "all",
      query: "",
      service: "all",
      status: "all",
      type: "page"
    })
    return index.items.map(({ projection }) => projection)
  },
  load: async (entityId, signal) => (await browserWorkspaceEntityTransport.load(entityId, signal)).entity.projection
})

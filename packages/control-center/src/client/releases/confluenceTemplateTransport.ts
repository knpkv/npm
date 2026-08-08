import * as Predicate from "effect/Predicate"
import type { DeliveryEntityProjection } from "../../domain/deliveryGraph.js"
import type { EntityId } from "../../domain/identifiers.js"
import { browserWorkspaceEntityTransport } from "../entities/useWorkspaceEntity.js"
import { browserWorkspaceItemsTransport } from "../items/useWorkspaceItems.js"

const MAXIMUM_CONFLUENCE_TEMPLATES = 50
const CONFLUENCE_TEMPLATE_BATCH_SIZE = 8
const TEMPLATE_TITLE_PATTERN = /\btemplate\b/iu

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
    const leftTemplate = TEMPLATE_TITLE_PATTERN.test(left.title) ? 0 : 1
    const rightTemplate = TEMPLATE_TITLE_PATTERN.test(right.title) ? 0 : 1
    return leftTemplate - rightTemplate || left.title.localeCompare(right.title)
  })

const isTemplateSummary = (projection: DeliveryEntityProjection): boolean =>
  projection.entityState === "present" &&
  projection.details._tag === "page" &&
  TEMPLATE_TITLE_PATTERN.test(projection.title)

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
      const projections = await Promise.allSettled(
        batch.map(({ entityId }) => source.load(entityId, signal))
      )
      for (const result of projections) {
        if (result.status === "rejected") {
          if (Predicate.isTagged("NotFoundApiError")(result.reason)) continue
          throw result.reason
        }
        const template = templateFor(result.value)
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

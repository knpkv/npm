import { Casing, Column, Query, Renderer } from "effect-qb"

import type { RenderedSql } from "./types.js"

/** Values required to follow one provider resource. */
export interface CreateFollowedResourceQueryInput {
  readonly createdAt: string
  readonly displayName: string
  readonly followedResourceId: string
  readonly isEnabled: boolean
  readonly providerAccountId: string
  readonly providerFamily: string
  readonly providerId: string
  readonly vendorResourceId: string
  readonly workspaceId: string
}

/** Workspace-scoped followed-resource lookup. */
export interface FollowedResourceQueryInput {
  readonly followedResourceId: string
  readonly workspaceId: string
}

/** Values required for an optimistic followed-resource metadata update. */
export interface UpdateFollowedResourceQueryInput extends FollowedResourceQueryInput {
  readonly displayName: string
  readonly expectedRevision: number
  readonly isEnabled: boolean
  readonly updatedAt: string
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Renderer.make().pipe(Casing.withCasing("snake_case"))

const followedResources = table("followedResources", {
  workspaceId: Column.text(),
  followedResourceId: Column.text(),
  providerAccountId: Column.text(),
  providerFamily: Column.text(),
  providerId: Column.text(),
  vendorResourceId: Column.text(),
  displayName: Column.text(),
  isEnabled: Column.int(),
  revision: Column.int(),
  createdAt: Column.text(),
  updatedAt: Column.text()
})

const selection = {
  workspaceId: followedResources.workspaceId,
  followedResourceId: followedResources.followedResourceId,
  providerAccountId: followedResources.providerAccountId,
  providerFamily: followedResources.providerFamily,
  providerId: followedResources.providerId,
  vendorResourceId: followedResources.vendorResourceId,
  displayName: followedResources.displayName,
  isEnabled: followedResources.isEnabled,
  revision: followedResources.revision,
  createdAt: followedResources.createdAt,
  updatedAt: followedResources.updatedAt
}

/** Render a workspace-scoped lookup for one followed resource. */
export const renderFollowedResourceQuery = (input: FollowedResourceQueryInput): RenderedSql => {
  const plan = Query.select(selection).pipe(
    Query.from(followedResources),
    Query.where(
      Query.and(
        Query.eq(followedResources.workspaceId, input.workspaceId),
        Query.eq(followedResources.followedResourceId, input.followedResourceId)
      )
    )
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render a stable account-scoped followed-resource listing. */
export const renderFollowedResourcesQuery = (
  workspaceId: string,
  providerAccountId: string
): RenderedSql => {
  const plan = Query.select(selection).pipe(
    Query.from(followedResources),
    Query.where(
      Query.and(
        Query.eq(followedResources.workspaceId, workspaceId),
        Query.eq(followedResources.providerAccountId, providerAccountId)
      )
    ),
    Query.orderBy(followedResources.providerId),
    Query.orderBy(followedResources.displayName),
    Query.orderBy(followedResources.followedResourceId)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render insertion of one followed resource. */
export const renderCreateFollowedResourceQuery = (input: CreateFollowedResourceQueryInput): RenderedSql => {
  const plan = Query.insert(followedResources, {
    ...input,
    isEnabled: input.isEnabled ? 1 : 0,
    revision: 1,
    updatedAt: input.createdAt
  })
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render an optimistic metadata update for one followed resource. */
export const renderUpdateFollowedResourceQuery = (input: UpdateFollowedResourceQueryInput): RenderedSql => {
  const plan = Query.update(followedResources, {
    displayName: input.displayName,
    isEnabled: input.isEnabled ? 1 : 0,
    revision: input.expectedRevision + 1,
    updatedAt: input.updatedAt
  }).pipe(
    Query.where(
      Query.and(
        Query.eq(followedResources.workspaceId, input.workspaceId),
        Query.eq(followedResources.followedResourceId, input.followedResourceId),
        Query.eq(followedResources.revision, input.expectedRevision)
      )
    )
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

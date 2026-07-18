import { Casing, Column, Query, Renderer } from "effect-qb"

import type { RenderedSql } from "./types.js"

/** Values required to create one provider account. */
export interface CreateProviderAccountQueryInput {
  readonly createdAt: string
  readonly displayName: string
  readonly providerAccountId: string
  readonly providerFamily: string
  readonly vendorAccountId: string
  readonly workspaceId: string
}

/** Workspace-scoped provider-account lookup. */
export interface ProviderAccountQueryInput {
  readonly providerAccountId: string
  readonly workspaceId: string
}

/** Immutable provider identity used to prevent duplicate accounts in one workspace. */
export interface ProviderAccountIdentityQueryInput {
  readonly providerFamily: string
  readonly vendorAccountId: string
  readonly workspaceId: string
}

/** Values required for an optimistic provider-account metadata update. */
export interface UpdateProviderAccountQueryInput extends ProviderAccountQueryInput {
  readonly displayName: string
  readonly expectedRevision: number
  readonly updatedAt: string
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Renderer.make().pipe(Casing.withCasing("snake_case"))

const providerAccounts = table("providerAccounts", {
  workspaceId: Column.text(),
  providerAccountId: Column.text(),
  providerFamily: Column.text(),
  vendorAccountId: Column.text(),
  displayName: Column.text(),
  revision: Column.int(),
  createdAt: Column.text(),
  updatedAt: Column.text()
})

const selection = {
  workspaceId: providerAccounts.workspaceId,
  providerAccountId: providerAccounts.providerAccountId,
  providerFamily: providerAccounts.providerFamily,
  vendorAccountId: providerAccounts.vendorAccountId,
  displayName: providerAccounts.displayName,
  revision: providerAccounts.revision,
  createdAt: providerAccounts.createdAt,
  updatedAt: providerAccounts.updatedAt
}

/** Render a workspace-scoped lookup for one provider account. */
export const renderProviderAccountQuery = (input: ProviderAccountQueryInput): RenderedSql => {
  const plan = Query.select(selection).pipe(
    Query.from(providerAccounts),
    Query.where(
      Query.and(
        Query.eq(providerAccounts.workspaceId, input.workspaceId),
        Query.eq(providerAccounts.providerAccountId, input.providerAccountId)
      )
    )
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render a stable workspace-scoped provider-account listing. */
export const renderProviderAccountsQuery = (workspaceId: string): RenderedSql => {
  const plan = Query.select(selection).pipe(
    Query.from(providerAccounts),
    Query.where(Query.eq(providerAccounts.workspaceId, workspaceId)),
    Query.orderBy(providerAccounts.displayName),
    Query.orderBy(providerAccounts.providerAccountId)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render a workspace-scoped lookup by immutable provider identity. */
export const renderProviderAccountIdentityQuery = (
  input: ProviderAccountIdentityQueryInput
): RenderedSql => {
  const plan = Query.select({ providerAccountId: providerAccounts.providerAccountId }).pipe(
    Query.from(providerAccounts),
    Query.where(
      Query.and(
        Query.eq(providerAccounts.workspaceId, input.workspaceId),
        Query.eq(providerAccounts.providerFamily, input.providerFamily),
        Query.eq(providerAccounts.vendorAccountId, input.vendorAccountId)
      )
    )
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render insertion of one provider account. */
export const renderCreateProviderAccountQuery = (input: CreateProviderAccountQueryInput): RenderedSql => {
  const plan = Query.insert(providerAccounts, { ...input, revision: 1, updatedAt: input.createdAt })
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render an optimistic metadata update for one provider account. */
export const renderUpdateProviderAccountQuery = (input: UpdateProviderAccountQueryInput): RenderedSql => {
  const plan = Query.update(providerAccounts, {
    displayName: input.displayName,
    revision: input.expectedRevision + 1,
    updatedAt: input.updatedAt
  }).pipe(
    Query.where(
      Query.and(
        Query.eq(providerAccounts.workspaceId, input.workspaceId),
        Query.eq(providerAccounts.providerAccountId, input.providerAccountId),
        Query.eq(providerAccounts.revision, input.expectedRevision)
      )
    )
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

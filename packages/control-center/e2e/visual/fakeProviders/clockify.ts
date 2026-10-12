const owner = {
  id: "fixture-owner",
  name: "Release Owner",
  email: "owner@example.com",
  activeWorkspace: "fixture-workspace",
  status: "ACTIVE"
}
const entry = {
  id: "fixture-entry",
  billable: false,
  description: "FIX-1 release 1.0.0 verification",
  userId: "fixture-owner",
  workspaceId: "fixture-workspace",
  projectId: "fixture-project",
  tagIds: [],
  taskId: null,
  customFieldValues: [],
  isLocked: false,
  timeInterval: { start: "2026-07-14T11:00:00.000Z", end: "2026-07-14T11:30:00.000Z", duration: "PT30M" }
}

/** Clockify wire data includes both generated OpenAPI fields and the real normalizer's scoped identity fields. */
export const clockifyResponse = (url: URL) => {
  const path = url.pathname
  if (path === "/api/v1/user") return owner
  if (path === "/api/v1/workspaces") return [{ id: "fixture-workspace", name: "Fixture workspace" }]
  if (/^\/api\/v1\/workspaces\/[^/]+\/users$/u.test(path)) return [owner]
  if (/^\/api\/v1\/workspaces\/[^/]+\/user\/[^/]+\/time-entries$/u.test(path)) {
    return Number(url.searchParams.get("page") ?? "1") > 1 ? [] : [entry]
  }
  if (/^\/api\/v1\/workspaces\/[^/]+\/time-entries\/[^/]+$/u.test(path)) return entry
  return undefined
}

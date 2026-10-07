/**
 * Which endpoints the hub page may poll, from what its own listener says it serves. A host
 * dashboard (non-canonical) has no chat or push endpoints, and no Work snapshot when it is
 * cross-host; polling them only produced 404s.
 *
 * @module
 */
export interface DashboardPolls {
  readonly chat: boolean
  readonly push: boolean
  readonly work: boolean
}

export const dashboardPolls = (served: {
  readonly chatEnabled: boolean
  readonly pushEnabled: boolean
  readonly workEnabled: boolean
}): DashboardPolls => ({ chat: served.chatEnabled, push: served.pushEnabled, work: served.workEnabled })

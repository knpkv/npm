/**
 * Which endpoints the hub page may poll, from what its own listener says it serves. A host
 * dashboard (non-canonical) has no push endpoints, and no Work snapshot when it is
 * cross-host; polling them only produced 404s.
 *
 * @module
 */
export interface DashboardPolls {
  readonly push: boolean
  readonly work: boolean
}

export const dashboardPolls = (served: {
  readonly pushEnabled: boolean
  readonly workEnabled: boolean
}): DashboardPolls => ({ push: served.pushEnabled, work: served.workEnabled })

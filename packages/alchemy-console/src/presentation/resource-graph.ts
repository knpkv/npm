import type { ResourceSummary } from "../schema.js"

/** Invert persisted downstream edges once. Incomplete, duplicate or unbounded graphs cannot prove dependencies. */
export const indexDependencies = <Resource extends Pick<ResourceSummary, "fqn" | "downstream">>(
  resources: ReadonlyArray<Resource>
): ReadonlyMap<string, ReadonlyArray<Resource>> | null => {
  if (resources.length > 50_000) return null
  const byFqn = new Map(resources.map((resource) => [resource.fqn, resource]))
  if (byFqn.size !== resources.length) return null
  const dependencies = new Map<string, Array<Resource>>(resources.map((resource) => [resource.fqn, []]))
  let edges = 0
  for (const resource of resources) {
    if (resource.downstream === null) return null
    edges += resource.downstream.length
    if (edges > 100_000) return null
    for (const dependent of new Set(resource.downstream)) {
      const upstreams = dependencies.get(dependent)
      if (upstreams === undefined || dependent === resource.fqn) return null
      upstreams.push(resource)
    }
  }
  return dependencies
}

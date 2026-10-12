import { expect, it } from "@effect/vitest"
import { indexDependencies } from "../src/presentation/resource-graph.js"
import type { ResourceSummary } from "../src/schema.js"

const resource = (fqn: string, downstream: ResourceSummary["downstream"]): ResourceSummary => ({
  fqn,
  downstream,
  logicalId: fqn,
  resourceType: "Custom.Resource",
  status: "created",
  parent: null,
  providerId: null,
  region: null,
  account: null,
  consoleUrl: null,
  updatedAt: null
})

it("inverts downstream once: a role naming Api means Api depends on the role, not the reverse", () => {
  const role = resource("Role", ["Api"])
  const api = resource("Api", [])
  const graph = indexDependencies([role, api])
  expect(graph?.get("Api")).toEqual([role])
  expect(graph?.get("Role")).toEqual([])
})

it("does not claim dependency knowledge for missing, dangling, duplicate or over-limit graphs", () => {
  expect(indexDependencies([resource("Api", null)])).toBeNull()
  expect(indexDependencies([resource("Api", ["Outside"])])).toBeNull()
  expect(indexDependencies([resource("Api", []), resource("Api", [])])).toBeNull()
  expect(indexDependencies([resource("Api", ["Api"])])).toBeNull()
  expect(indexDependencies([resource("Api", Array.from({ length: 100_001 }, () => "Role")), resource("Role", [])]))
    .toBeNull()
  expect(indexDependencies([resource("Api", []), resource("Role", ["Api", "Api"])])?.get("Api")).toHaveLength(1)
})

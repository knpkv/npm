import { expect, it } from "@effect/vitest"
import { groupResourceTree } from "../src/presentation/ResourceTree.js"
import type { ResourcePresentation } from "../src/views.js"

const resource = (fqn: string, parent: string | null, resourceType: string): ResourcePresentation => ({
  fqn,
  parent,
  logicalId: fqn.split("/").at(-1) ?? fqn,
  resourceType,
  status: "created",
  downstream: [],
  providerId: null,
  account: null,
  region: null,
  consoleUrl: null,
  updatedAt: null
})
it("groups only actual returned construct parents and exact types without inventing a resource for namespaces", () => {
  const a = resource("Api/Worker", "Api", "Cloudflare.Worker")
  const b = resource("Api/Queue", "Api", "AWS.SQS.Queue")
  const c = resource("Api/Retry", "Api", "AWS.SQS.Queue")
  const root = resource("Root", null, "Custom.Root")
  const groups = groupResourceTree([a, b, c, root])
  expect(groups.map((group) => group.parent)).toEqual(["Api", null])
  expect([...groups[0]?.types ?? []]).toEqual([["Cloudflare.Worker", [a]], ["AWS.SQS.Queue", [b, c]]])
  expect(groups[0]?.resources).toEqual([a, b, c])
  expect(groupResourceTree([])).toEqual([])
})

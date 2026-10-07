import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { JiraApi } from "../src/index.js"

// @effect/openapi-generator 4.0.0 emits Schema.Never for these recursive unions; the committed client keeps them usable.
describe("recursive generated schemas", () => {
  it("decodes a nested JQL query clause", () => {
    const clause: typeof JiraApi.JqlQueryClause.Encoded = {
      clauses: [
        { field: { name: "project" }, operator: "=", operand: { value: "KNP" } },
        { clauses: [{ field: { name: "status" }, operator: "!=", operand: { value: "Done" } }], operator: "not" }
      ],
      operator: "and"
    }
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.JqlQueryClause)(clause), clause)
  })

  it("decodes a nested workflow condition tree", () => {
    const condition: typeof JiraApi.WorkflowCondition.Encoded = {
      conditions: [{ nodeType: "simple", type: "PermissionCondition", configuration: { permissionKey: "BROWSE" } }],
      nodeType: "compound",
      operator: "AND"
    }
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.WorkflowCondition)(condition), condition)
  })
})

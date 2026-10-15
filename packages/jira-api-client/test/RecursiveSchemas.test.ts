import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { JiraApi } from "../src/index.js"

// Closed union wrappers must not erase the properties declared by their referenced branches.
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

describe("regenerated public models", () => {
  it("rejects invalid nested union branches", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(JiraApi.JqlQueryClause)({ clauses: [{ operator: "invalid" }], operator: "and" })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(JiraApi.WorkflowCondition)({
        conditions: [{ nodeType: "simple" }],
        nodeType: "compound",
        operator: "AND"
      })
    )
  })

  it("keeps bulk-move schemas and the published linked-issue fields distinct", () => {
    const mapping: typeof JiraApi.TargetToSourcesMapping.Encoded = {
      inferClassificationDefaults: true,
      inferFieldDefaults: true,
      inferStatusDefaults: true,
      inferSubtaskTypeDefault: true,
      issueIdsOrKeys: ["APP-1"],
      targetMandatoryFields: [{ fields: { summary: { value: ["Title"] } } }]
    }
    const move: typeof JiraApi.IssueBulkMovePayload.Encoded = { targetToSourcesMapping: { "10000,10001": mapping } }
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.IssueBulkMovePayload)(move), move)
    const fields: typeof JiraApi.Fields1.Encoded = { summary: "Linked issue" }
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.Fields1)(fields), fields)
  })

  it("keeps context variables and security member requests usable", () => {
    const variable: typeof JiraApi.CustomContextVariable.Encoded = { accountId: "account", type: "user" }
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.CustomContextVariable)(variable), variable)
    const members: typeof JiraApi.SecuritySchemeMembersRequest.Encoded = { members: [] }
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.SecuritySchemeMembersRequest)(members), members)
  })

  it("retains unreferenced upload and user-filter models", () => {
    const file: typeof JiraApi.MultipartFile.Encoded = { name: "file", resource: { description: "Receipt" } }
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.MultipartFile)(file), file)
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.Resource)({ description: "Receipt" }), {
      description: "Receipt"
    })
    assert.deepStrictEqual(Schema.decodeUnknownSync(JiraApi.UserFilter)({ enabled: true, groups: ["developers"] }), {
      enabled: true,
      groups: ["developers"]
    })
  })
})

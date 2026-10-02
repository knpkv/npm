---
"@knpkv/jira-api-client": major
"@knpkv/jira-cli": patch
"@knpkv/jira-clockify": patch
---

Update the generated Schema-backed Jira API client.

Breaking: these exported types now include `null`, so code that reads them must handle it: `ApprovalConfiguration`, `BoardFeaturesPayload`, `BoardsPayload`, `ConditionGroupConfiguration`, `ConditionGroupUpdate`, `CustomFieldPayload`, `FieldCapabilityPayload`, `FieldLayoutPayload`, `FieldLayoutSchemePayload`, `FieldSchemePayload`, `IssueLayoutPayload`, `IssueTypeHierarchyPayload`, `IssueTypePayload`, `IssueTypeProjectCreatePayload`, `IssueTypeScreenSchemePayload`, `NotificationSchemePayload`, `PermissionPayloadDTO`, `PreviewConditionGroupConfiguration`, `PreviewRuleConfiguration`, `ProjectId`, `RolesCapabilityPayload`, `ScopePayload`, `ScreenPayload`, `ScreenSchemePayload`, `SecuritySchemePayload`, `TargetClassification`, `TargetMandatoryFields`, `TargetStatus`, `WorkflowCapabilityPayload`, `WorkflowLayout`, `WorkflowProjectIdScope`, `WorkflowRuleConfiguration`, `WorkflowStatusLayout`, and `WorkflowTransitionLinks`. `ProjectId` and `WorkflowLayout` also appear in responses. No exports are removed; 129 are added.

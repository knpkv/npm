import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { SchemaError } from "effect/Schema"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
// non-recursive definitions
export type AdminKeyResponse = { readonly "accountId"?: string, readonly "expirationTime"?: string }
export const AdminKeyResponse = Schema.Struct({ "accountId": Schema.optionalKey(Schema.String.annotate({ "description": "User identifier." })), "expirationTime": Schema.optionalKey(Schema.String.annotate({ "description": "Timestamp in UTC that represents when the admin key will expire. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })) })
export type BodyType = { readonly "representation"?: string, readonly "value"?: string }
export const BodyType = Schema.Struct({ "representation": Schema.optionalKey(Schema.String.annotate({ "description": "Type of content representation used for the value field." })), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Body of the content, in the format found in the representation field." })) })
export type PrimaryBodyRepresentation = "storage" | "atlas_doc_format"
export const PrimaryBodyRepresentation = Schema.Literals(["storage", "atlas_doc_format"]).annotate({ "description": "The primary formats a body can be represented as. A subset of BodyRepresentation. These formats are the only allowed formats in certain use cases." })
export type PrimaryBodyRepresentationSingle = "storage" | "atlas_doc_format" | "view" | "export_view" | "anonymous_export_view" | "styled_view" | "editor"
export const PrimaryBodyRepresentationSingle = Schema.Literals(["storage", "atlas_doc_format", "view", "export_view", "anonymous_export_view", "styled_view", "editor"]).annotate({ "description": "The primary formats a body can be represented as. A subset of BodyRepresentation. These formats are the only allowed formats in certain use cases." })
export type CustomContentBodyRepresentation = "raw" | "storage" | "atlas_doc_format"
export const CustomContentBodyRepresentation = Schema.Literals(["raw", "storage", "atlas_doc_format"]).annotate({ "description": "The formats a custom content body can be represented as. A subset of BodyRepresentation." })
export type CustomContentBodyRepresentationSingle = "raw" | "storage" | "atlas_doc_format" | "view" | "export_view" | "anonymous_export_view"
export const CustomContentBodyRepresentationSingle = Schema.Literals(["raw", "storage", "atlas_doc_format", "view", "export_view", "anonymous_export_view"]).annotate({ "description": "The formats a custom content body can be represented as. A subset of BodyRepresentation." })
export type SpaceDescriptionBodyRepresentation = "plain" | "view"
export const SpaceDescriptionBodyRepresentation = Schema.Literals(["plain", "view"]).annotate({ "description": "The formats a space description can be represented as. A subset of BodyRepresentation." })
export type ContentIdToContentTypeResponse = { readonly "results"?: { readonly [x: string]: "page" | "blogpost" | "attachment" | "footer-comment" | "inline-comment" | string } }
export const ContentIdToContentTypeResponse = Schema.Struct({ "results": Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.Literals(["page", "blogpost", "attachment", "footer-comment", "inline-comment"]).annotate({ "description": "Built in content types" }), Schema.String.annotate({ "description": "Custom content types" })])).annotate({ "description": "JSON object containing all requested content ids as keys and their associated content types as the values.\nDuplicate content ids in the request will be returned under a single key in the response. For built-in content\ntypes, the enumerations are as specified. Custom content ids will be mapped to their associated type." })) })
export type ContentStatus = "current" | "draft" | "archived" | "historical" | "trashed" | "deleted" | "any"
export const ContentStatus = Schema.Literals(["current", "draft", "archived", "historical", "trashed", "deleted", "any"]).annotate({ "description": "The status of the content." })
export type BlogPostContentStatus = "current" | "draft" | "historical" | "trashed" | "deleted" | "any"
export const BlogPostContentStatus = Schema.Literals(["current", "draft", "historical", "trashed", "deleted", "any"]).annotate({ "description": "The status of the content." })
export type OnlyArchivedAndCurrentContentStatus = "current" | "archived"
export const OnlyArchivedAndCurrentContentStatus = Schema.Literals(["current", "archived"]).annotate({ "description": "The status of the content." })
export type ContentPropertyCreateRequest = { readonly "key"?: string, readonly "value"?: Schema.Json }
export const ContentPropertyCreateRequest = Schema.Struct({ "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the content property" })), "value": Schema.optionalKey(Schema.Json.annotate({ "description": "Value of the content property." })) })
export type ContentPropertyUpdateRequest = { readonly "key"?: string, readonly "value"?: Schema.Json, readonly "version"?: { readonly "number"?: number, readonly "message"?: string } }
export const ContentPropertyUpdateRequest = Schema.Struct({ "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the content property" })), "value": Schema.optionalKey(Schema.Json.annotate({ "description": "Value of the content property." })), "version": Schema.optionalKey(Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "description": "Version number of the new version. Should be 1 more than the current version number.", "format": "int32" }).check(Schema.isInt())), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message to be associated with the new version." })) }).annotate({ "description": "New version number and associated message" })) })
export type DetailedVersion = { readonly "number"?: number, readonly "authorId"?: string, readonly "message"?: string, readonly "createdAt"?: string, readonly "minorEdit"?: boolean, readonly "contentTypeModified"?: boolean, readonly "collaborators"?: ReadonlyArray<string>, readonly "prevVersion"?: number, readonly "nextVersion"?: number }
export const DetailedVersion = Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The current version number.", "format": "int32" }).check(Schema.isInt())), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this version." })), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message associated with the current version." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the version was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "minorEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Describes if this version is a minor version. Email notifications and activity stream updates are not created for minor versions." })), "contentTypeModified": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Describes if the content type is modified in this version (e.g. page to blog)" })), "collaborators": Schema.optionalKey(Schema.Array(Schema.String).annotate({ "description": "The account IDs of users that collaborated on this version." })), "prevVersion": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number of the version prior to this current content update.", "format": "int32" }).check(Schema.isInt())), "nextVersion": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number of the version after this current content update.", "format": "int32" }).check(Schema.isInt())) })
export type Label = { readonly "id"?: string, readonly "name"?: string, readonly "prefix"?: string }
export const Label = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the label." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Name of the label." })), "prefix": Schema.optionalKey(Schema.String.annotate({ "description": "Prefix of the label." })) })
export type Like = { readonly "accountId"?: string }
export const Like = Schema.Struct({ "accountId": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID." })) })
export type Operation = { readonly "operation"?: string, readonly "targetType"?: string }
export const Operation = Schema.Struct({ "operation": Schema.optionalKey(Schema.String.annotate({ "description": "The type of operation." })), "targetType": Schema.optionalKey(Schema.String.annotate({ "description": "The type of entity the operation type targets." })) })
export type ParentContentType = "page" | "whiteboard" | "database" | "embed" | "folder"
export const ParentContentType = Schema.Literals(["page", "whiteboard", "database", "embed", "folder"]).annotate({ "description": "Content type of the parent, or null if there is no parent." })
export type PageBodyWrite = { readonly "representation"?: "storage" | "atlas_doc_format" | "wiki", readonly "value"?: string }
export const PageBodyWrite = Schema.Struct({ "representation": Schema.optionalKey(Schema.Literals(["storage", "atlas_doc_format", "wiki"]).annotate({ "description": "Type of content representation used for the value field." })), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Body of the page, in the format found in the representation field." })) })
export type BlogPostBodyWrite = { readonly "representation"?: "storage" | "atlas_doc_format" | "wiki", readonly "value"?: string }
export const BlogPostBodyWrite = Schema.Struct({ "representation": Schema.optionalKey(Schema.Literals(["storage", "atlas_doc_format", "wiki"]).annotate({ "description": "Type of content representation used for the value field." })), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Body of the blog post, in the format found in the representation field." })) })
export type CommentBodyWrite = { readonly "representation"?: "storage" | "atlas_doc_format" | "wiki", readonly "value"?: string }
export const CommentBodyWrite = Schema.Struct({ "representation": Schema.optionalKey(Schema.Literals(["storage", "atlas_doc_format", "wiki"]).annotate({ "description": "Type of content representation used for the value field." })), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Body of the comment, in the format found in the representation field." })) })
export type CustomContentBodyWrite = { readonly "representation"?: "storage" | "atlas_doc_format" | "raw", readonly "value"?: string }
export const CustomContentBodyWrite = Schema.Struct({ "representation": Schema.optionalKey(Schema.Literals(["storage", "atlas_doc_format", "raw"]).annotate({ "description": "Type of content representation used for the value field." })), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Body of the custom content, in the format found in the representation field." })) })
export type AncestorType = "page" | "whiteboard" | "database" | "embed" | "folder"
export const AncestorType = Schema.Literals(["page", "whiteboard", "database", "embed", "folder"]).annotate({ "description": "The type of ancestor." })
export type RedactionPointer = { readonly "pointer": string, readonly "from"?: number, readonly "to"?: number, readonly "reason"?: string | null }
export const RedactionPointer = Schema.Struct({ "pointer": Schema.String.annotate({ "description": "JSON pointer indicating the exact location within the content structure \nwhere redaction should be applied. Points to the text node containing the content to redact.\n" }), "from": Schema.optionalKey(Schema.Number.annotate({ "description": "Starting character index (zero-based) within the target text where redaction begins.\n" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "to": Schema.optionalKey(Schema.Number.annotate({ "description": "Ending character index (zero-based) within the target text where redaction ends (exclusive).\nMust be greater than or equal to 'from' value.\n" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "reason": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Optional human-readable reason for the redaction. Used for audit trails and compliance documentation.\n" })) })
export type RedactionPointerResponse = { readonly "pointer"?: string, readonly "from"?: number, readonly "to"?: number, readonly "reason"?: string, readonly "redactionId"?: string }
export const RedactionPointerResponse = Schema.Struct({ "pointer": Schema.optionalKey(Schema.String.annotate({ "description": "JSON pointer indicating where the redaction was applied" })), "from": Schema.optionalKey(Schema.Number.annotate({ "description": "Starting character index where redaction was applied" }).check(Schema.isInt())), "to": Schema.optionalKey(Schema.Number.annotate({ "description": "Ending character index where redaction was applied" }).check(Schema.isInt())), "reason": Schema.optionalKey(Schema.String.annotate({ "description": "Reason for the redaction" })), "redactionId": Schema.optionalKey(Schema.String.annotate({ "description": "Unique identifier for this redaction. Can be used to restore the redacted content later.\n", "format": "uuid" })) })
export type SpaceIcon = { readonly "path"?: string, readonly "apiDownloadLink"?: string }
export const SpaceIcon = Schema.Struct({ "path": Schema.optionalKey(Schema.String.annotate({ "description": "The path (relative to base URL) at which the space's icon can be retrieved. The format should be like `/wiki/download/...` or `/wiki/aa-avatar/...`" })), "apiDownloadLink": Schema.optionalKey(Schema.String.annotate({ "description": "The path (relative to base URL) that can be used to retrieve a link to download the space icon. 3LO apps should use this link instead of the value provided\nin the `path` property to retrieve the icon.\n\nCurrently this field is only returned for `global` spaces and not `personal` spaces.\n" })) }).annotate({ "description": "The icon of the space" })
export type SpacePermission = { readonly "id"?: string, readonly "displayName"?: string, readonly "description"?: string, readonly "requiredPermissionIds"?: ReadonlyArray<string> }
export const SpacePermission = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "The identifier for the space permission." })), "displayName": Schema.optionalKey(Schema.String.annotate({ "description": "The display name for the space permission." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Describes the space permission’s usage." })), "requiredPermissionIds": Schema.optionalKey(Schema.Array(Schema.String).annotate({ "description": "The permissions required for this permission to be enabled." })) })
export type SpacePermissionAssignment = { readonly "id"?: string, readonly "principal"?: { readonly "type"?: "user" | "group" | "role", readonly "id"?: string }, readonly "operation"?: { readonly "key"?: "use" | "create" | "read" | "update" | "delete" | "copy" | "move" | "export" | "purge" | "purge_version" | "administer" | "restore" | "create_space" | "restrict_content" | "archive", readonly "targetType"?: "page" | "blogpost" | "comment" | "attachment" | "whiteboard" | "database" | "embed" | "folder" | "space" | "application" | "userProfile" } }
export const SpacePermissionAssignment = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space permission." })), "principal": Schema.optionalKey(Schema.Struct({ "type": Schema.optionalKey(Schema.Literals(["user", "group", "role"])), "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the entity." })) }).annotate({ "description": "The entity the space permissions corresponds to." })), "operation": Schema.optionalKey(Schema.Struct({ "key": Schema.optionalKey(Schema.Literals(["use", "create", "read", "update", "delete", "copy", "move", "export", "purge", "purge_version", "administer", "restore", "create_space", "restrict_content", "archive"]).annotate({ "description": "The type of operation." })), "targetType": Schema.optionalKey(Schema.Literals(["page", "blogpost", "comment", "attachment", "whiteboard", "database", "embed", "folder", "space", "application", "userProfile"]).annotate({ "description": "The type of entity the operation type targets." })) }).annotate({ "description": "The operation the space permission corresponds to." })) })
export type DeleteSpaceRoleResponse = { readonly "taskId"?: string }
export const DeleteSpaceRoleResponse = Schema.Struct({ "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Id of the task to update the space permissions associated with the space role" })) })
export type BulkTransitionTaskResponse = { readonly "taskId": string, readonly "status": "IN_PROGRESS" | "COMPLETED" | "FAILED", readonly "statusUrl": string }
export const BulkTransitionTaskResponse = Schema.Struct({ "taskId": Schema.String.annotate({ "description": "The ID of the async task." }), "status": Schema.Literals(["IN_PROGRESS", "COMPLETED", "FAILED"]).annotate({ "description": "The current status of the task." }), "statusUrl": Schema.String.annotate({ "description": "URL to poll for task progress." }) })
export type BulkTransitionTaskStatusResponse = { readonly "taskId": string, readonly "status": "IN_PROGRESS" | "COMPLETED" | "FAILED", readonly "errorMessage"?: string | null }
export const BulkTransitionTaskStatusResponse = Schema.Struct({ "taskId": Schema.String.annotate({ "description": "The ID of the task." }), "status": Schema.Literals(["IN_PROGRESS", "COMPLETED", "FAILED"]).annotate({ "description": "The current status of the task." }), "errorMessage": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Human-readable error message describing why the task failed. Only present when status is FAILED." })) })
export type BulkTransitionPrincipalTypeAssignment = { readonly "principalType": "USER" | "GROUP" | "GUEST" | "ANONYMOUS" | "ALL_LICENSED_USERS_USER_CLASS" | "ALL_PRODUCT_ADMINS_USER_CLASS" | "APP", readonly "removeAccess": boolean, readonly "roleId"?: string | null }
export const BulkTransitionPrincipalTypeAssignment = Schema.Struct({ "principalType": Schema.Literals(["USER", "GROUP", "GUEST", "ANONYMOUS", "ALL_LICENSED_USERS_USER_CLASS", "ALL_PRODUCT_ADMINS_USER_CLASS", "APP"]).annotate({ "description": "The type of principal." }), "removeAccess": Schema.Boolean.annotate({ "description": "Whether to remove access for this principal type instead of assigning a role." }), "roleId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The UUID of the space role to assign. Required when removeAccess is false." })) })
export type BulkTransitionSpaceTarget = { readonly "id": string, readonly "key": string }
export const BulkTransitionSpaceTarget = Schema.Struct({ "id": Schema.String.annotate({ "description": "The space ID." }), "key": Schema.String.annotate({ "description": "The space key." }) })
export type BulkTransitionDecodedPermission = { readonly "id": string, readonly "displayName": string }
export const BulkTransitionDecodedPermission = Schema.Struct({ "id": Schema.String.annotate({ "description": "The platform id of the permission (e.g. `VIEW_CONTENT`)." }), "displayName": Schema.String.annotate({ "description": "Human-readable name of the permission." }) })
export type PrincipalType = "USER" | "GROUP" | "ACCESS_CLASS"
export const PrincipalType = Schema.Literals(["USER", "GROUP", "ACCESS_CLASS"]).annotate({ "description": "The principal type." })
export type RoleType = "SYSTEM" | "CUSTOM"
export const RoleType = Schema.Literals(["SYSTEM", "CUSTOM"]).annotate({ "description": "The role type." })
export type SpaceProperty = { readonly "id"?: string, readonly "key"?: string, readonly "value"?: Schema.Json, readonly "createdAt"?: string, readonly "createdBy"?: string, readonly "version"?: { readonly "createdAt"?: string, readonly "createdBy"?: string, readonly "message"?: string, readonly "number"?: number } }
export const SpaceProperty = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space property." })), "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the space property." })), "value": Schema.optionalKey(Schema.Json.annotate({ "description": "Value of the space property." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "RFC3339 compliant date time at which the property was created.", "format": "date-time" })), "createdBy": Schema.optionalKey(Schema.String.annotate({ "description": "Atlassian account ID of the user that created the space property." })), "version": Schema.optionalKey(Schema.Struct({ "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "RFC3339 compliant date time at which the property's current version was created.", "format": "date-time" })), "createdBy": Schema.optionalKey(Schema.String.annotate({ "description": "Atlassian account ID of the user that created the space property's current version." })), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message associated with the current version." })), "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The space property's current version number.", "format": "int32" }).check(Schema.isInt())) })) })
export type SpacePropertyCreateRequest = { readonly "key"?: string, readonly "value"?: Schema.Json }
export const SpacePropertyCreateRequest = Schema.Struct({ "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the space property" })), "value": Schema.optionalKey(Schema.Json.annotate({ "description": "Value of the space property." })) })
export type SpacePropertyUpdateRequest = { readonly "key"?: string, readonly "value"?: Schema.Json, readonly "version"?: { readonly "number"?: number, readonly "message"?: string } }
export const SpacePropertyUpdateRequest = Schema.Struct({ "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the space property" })), "value": Schema.optionalKey(Schema.Json.annotate({ "description": "Value of the space property." })), "version": Schema.optionalKey(Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "description": "Version number of the new version. Should be 1 more than the current version number.", "format": "int32" }).check(Schema.isInt())), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message to be associated with the new version." })) }).annotate({ "description": "New version number and associated message" })) })
export type SpaceType = "global" | "collaboration" | "knowledge_base" | "personal" | "system" | "onboarding" | "xflow_sample_space"
export const SpaceType = Schema.Literals(["global", "collaboration", "knowledge_base", "personal", "system", "onboarding", "xflow_sample_space"]).annotate({ "description": "The type of space." })
export type SpaceStatus = "current" | "archived"
export const SpaceStatus = Schema.Literals(["current", "archived"]).annotate({ "description": "The status of the space." })
export type AccountType = "atlassian" | "app" | "customer" | "unknown"
export const AccountType = Schema.Literals(["atlassian", "app", "customer", "unknown"]).annotate({ "description": "The account type of the user." })
export type AccountStatus = "active" | "inactive" | "closed" | "unknown"
export const AccountStatus = Schema.Literals(["active", "inactive", "closed", "unknown"]).annotate({ "description": "The account status of the user." })
export type Icon = { readonly "path": string, readonly "isDefault": boolean }
export const Icon = Schema.Union([Schema.Struct({ "path": Schema.String, "isDefault": Schema.Boolean }).annotate({ "description": "This object represents an icon. If used as a profilePicture, this may be returned as null, depending on the user's privacy setting." })])
export type Version = { readonly "createdAt"?: string, readonly "message"?: string, readonly "number"?: number, readonly "minorEdit"?: boolean, readonly "authorId"?: string }
export const Version = Schema.Struct({ "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the version was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message associated with the current version." })), "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number.", "format": "int32" }).check(Schema.isInt())), "minorEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Describes if this version is a minor version. Email notifications and activity stream updates are not created for minor versions." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this version." })) })
export type AttachmentSortOrder = "created-date" | "-created-date" | "modified-date" | "-modified-date"
export const AttachmentSortOrder = Schema.Literals(["created-date", "-created-date", "modified-date", "-modified-date"]).annotate({ "description": "The sort fields for attachments. The default sort direction is ascending. To sort in descending order, append a `-` character before the sort field. For example, `fieldName` or `-fieldName`." })
export type BlogPostSortOrder = "id" | "-id" | "created-date" | "-created-date" | "modified-date" | "-modified-date"
export const BlogPostSortOrder = Schema.Literals(["id", "-id", "created-date", "-created-date", "modified-date", "-modified-date"]).annotate({ "description": "The sort fields for blog posts. The default sort direction is ascending. To sort in descending order, append a `-` character before the sort field. For example, `fieldName` or `-fieldName`." })
export type CommentSortOrder = "created-date" | "-created-date" | "modified-date" | "-modified-date"
export const CommentSortOrder = Schema.Literals(["created-date", "-created-date", "modified-date", "-modified-date"]).annotate({ "description": "The sort fields for comments. The default sort direction is ascending. To sort in descending order, append a `-` character before the sort field. For example, `fieldName` or `-fieldName`." })
export type ContentPropertySortOrder = "key" | "-key"
export const ContentPropertySortOrder = Schema.Literals(["key", "-key"]).annotate({ "description": "The sort fields for content properties. The default sort direction is ascending. To sort in descending order, append a `-` character before the sort field. For example, `fieldName` or `-fieldName`." })
export type CustomContentSortOrder = "id" | "-id" | "created-date" | "-created-date" | "modified-date" | "-modified-date" | "title" | "-title"
export const CustomContentSortOrder = Schema.Literals(["id", "-id", "created-date", "-created-date", "modified-date", "-modified-date", "title", "-title"]).annotate({ "description": "The sort fields for custom content. The default sort direction is ascending. To sort in descending order, append a `-` character before the sort field. For example, `fieldName` or `-fieldName`." })
export type PageSortOrder = "id" | "-id" | "created-date" | "-created-date" | "modified-date" | "-modified-date" | "title" | "-title"
export const PageSortOrder = Schema.Literals(["id", "-id", "created-date", "-created-date", "modified-date", "-modified-date", "title", "-title"]).annotate({ "description": "The sort fields for pages. The default sort direction is ascending. To sort in descending order, append a `-` character before the sort field. For example, `fieldName` or `-fieldName`." })
export type SpaceSortOrder = "id" | "-id" | "key" | "-key" | "name" | "-name"
export const SpaceSortOrder = Schema.Literals(["id", "-id", "key", "-key", "name", "-name"]).annotate({ "description": "The sort fields for spaces. The default sort direction is ascending. To sort in descending order, append a `-` character before the sort field. For example, `fieldName` or `-fieldName`." })
export type VersionSortOrder = "modified-date" | "-modified-date"
export const VersionSortOrder = Schema.Literals(["modified-date", "-modified-date"]).annotate({ "description": "The sort fields for versions. The default sort direction is ascending. To sort in descending order, append a `-` character before the sort field. For example, `fieldName` or `-fieldName`." })
export type InlineCommentResolutionStatus = "open" | "reopened" | "resolved" | "dangling"
export const InlineCommentResolutionStatus = Schema.Literals(["open", "reopened", "resolved", "dangling"]).annotate({ "description": "Inline comment resolution status" })
export type InlineCommentProperties = { readonly "inlineMarkerRef"?: string, readonly "inlineOriginalSelection"?: string }
export const InlineCommentProperties = Schema.Struct({ "inlineMarkerRef": Schema.optionalKey(Schema.String.annotate({ "description": "Property value used to reference the highlighted element in DOM." })), "inlineOriginalSelection": Schema.optionalKey(Schema.String.annotate({ "description": "Text that is highlighted." })) })
export type AbstractPageLinks = { readonly "webui"?: string, readonly "editui"?: string, readonly "tinyui"?: string }
export const AbstractPageLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "tinyui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })) })
export type AttachmentLinks = { readonly "webui"?: string, readonly "download"?: string }
export const AttachmentLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "download": Schema.optionalKey(Schema.String.annotate({ "description": "Download link of the content." })) })
export type CustomContentLinks = { readonly "webui"?: string }
export const CustomContentLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })) })
export type CommentLinks = { readonly "webui"?: string }
export const CommentLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })) })
export type DatabaseLinks = { readonly "webui"?: string }
export const DatabaseLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })) })
export type FolderLinks = { readonly "webui"?: string }
export const FolderLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })) })
export type SmartLinkLinks = { readonly "webui"?: string }
export const SmartLinkLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })) })
export type SpaceLinks = { readonly "webui"?: string }
export const SpaceLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the space." })) })
export type WhiteboardLinks = { readonly "webui"?: string, readonly "editui"?: string }
export const WhiteboardLinks = Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })) })
export type DataPolicyMetadata = { readonly "anyContentBlocked"?: boolean }
export const DataPolicyMetadata = Schema.Struct({ "anyContentBlocked": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the workspace contains any content blocked for (inaccessible to) the requesting client application.", "readOnly": true })) }).annotate({ "description": "Details about data policies." })
export type OptionalFieldMeta = { readonly "hasMore"?: boolean, readonly "cursor"?: string }
export const OptionalFieldMeta = Schema.Struct({ "hasMore": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates if there are more available results that can be fetched." })), "cursor": Schema.optionalKey(Schema.String.annotate({ "description": "A token that can be used in the query parameter of the endpoint returned in the `_links` property to retrieve the next set of results." })) })
export type OptionalFieldLinks = { readonly "self"?: string }
export const OptionalFieldLinks = Schema.Struct({ "self": Schema.optionalKey(Schema.String.annotate({ "description": "A relative URL that can be used to fetch results beyond what this include parameter retrieves." })) })
export type MultiEntityLinks = { readonly "next"?: string, readonly "base"?: string }
export const MultiEntityLinks = Schema.Struct({ "next": Schema.optionalKey(Schema.String.annotate({ "description": "Used for pagination. Contains the relative URL for the next set of results, using a cursor query parameter.\nThis property will not be present if there is no additional data available." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })
export type ClassificationLevel = { readonly "id"?: string, readonly "status"?: "DRAFT" | "PUBLISHED" | "ARCHIVED", readonly "order"?: number, readonly "name"?: string, readonly "description"?: string, readonly "guideline"?: string, readonly "color"?: "RED" | "RED_BOLD" | "ORANGE" | "YELLOW" | "GREEN" | "BLUE" | "NAVY" | "TEAL" | "PURPLE" | "GREY" | "LIME" }
export const ClassificationLevel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "The ID of the classification level." })), "status": Schema.optionalKey(Schema.Literals(["DRAFT", "PUBLISHED", "ARCHIVED"]).annotate({ "description": "The status of the classification level." })), "order": Schema.optionalKey(Schema.Number.annotate({ "description": "The order of the classification level object." }).check(Schema.isFinite())), "name": Schema.optionalKey(Schema.String.annotate({ "description": "The name of the classification level object." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "The description of the classification level object." })), "guideline": Schema.optionalKey(Schema.String.annotate({ "description": "The guideline of the classification level object." })), "color": Schema.optionalKey(Schema.Literals(["RED", "RED_BOLD", "ORANGE", "YELLOW", "GREEN", "BLUE", "NAVY", "TEAL", "PURPLE", "GREY", "LIME"]).annotate({ "description": "The color of the classification level object." })) }).annotate({ "title": "ClassificationLevel", "description": "A unit of [data classification](https://support.atlassian.com/security-and-access-policies/docs/what-is-data-classification/) defined by an organiation. \nA classification level may be associated with specific storage and handling requirements or expectations." })
export type TaskBodySingle = { readonly "storage"?: BodyType, readonly "atlas_doc_format"?: BodyType }
export const TaskBodySingle = Schema.Struct({ "storage": Schema.optionalKey(BodyType), "atlas_doc_format": Schema.optionalKey(BodyType) }).annotate({ "description": "Contains fields for each representation type requested." })
export type BodySingle = { readonly "storage"?: BodyType, readonly "atlas_doc_format"?: BodyType, readonly "view"?: BodyType }
export const BodySingle = Schema.Struct({ "storage": Schema.optionalKey(BodyType), "atlas_doc_format": Schema.optionalKey(BodyType), "view": Schema.optionalKey(BodyType) }).annotate({ "description": "Contains fields for each representation type requested." })
export type BodyBulk = { readonly "storage"?: BodyType, readonly "atlas_doc_format"?: BodyType }
export const BodyBulk = Schema.Struct({ "storage": Schema.optionalKey(BodyType), "atlas_doc_format": Schema.optionalKey(BodyType) }).annotate({ "description": "Contains fields for each representation type requested." })
export type CustomContentBodySingle = { readonly "raw"?: BodyType, readonly "storage"?: BodyType, readonly "atlas_doc_format"?: BodyType, readonly "view"?: BodyType }
export const CustomContentBodySingle = Schema.Struct({ "raw": Schema.optionalKey(BodyType), "storage": Schema.optionalKey(BodyType), "atlas_doc_format": Schema.optionalKey(BodyType), "view": Schema.optionalKey(BodyType) }).annotate({ "description": "Contains fields for each representation type requested." })
export type CustomContentBodyBulk = { readonly "raw"?: BodyType, readonly "storage"?: BodyType, readonly "atlas_doc_format"?: BodyType }
export const CustomContentBodyBulk = Schema.Struct({ "raw": Schema.optionalKey(BodyType), "storage": Schema.optionalKey(BodyType), "atlas_doc_format": Schema.optionalKey(BodyType) }).annotate({ "description": "Contains fields for each representation type requested." })
export type SpaceDescription = { readonly "plain"?: BodyType, readonly "view"?: BodyType }
export const SpaceDescription = Schema.Struct({ "plain": Schema.optionalKey(BodyType), "view": Schema.optionalKey(BodyType) }).annotate({ "description": "Contains fields for each representation type requested." })
export type ChildPage = { readonly "id"?: string, readonly "status"?: OnlyArchivedAndCurrentContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "childPosition"?: number | null }
export const ChildPage = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page." })), "status": Schema.optionalKey(OnlyArchivedAndCurrentContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the page." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the page is in." })), "childPosition": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), Schema.Null]).annotate({ "description": "Position of the child page within its parent page tree." })) })
export type ChildCustomContent = { readonly "id"?: string, readonly "status"?: OnlyArchivedAndCurrentContentStatus, readonly "title"?: string, readonly "type"?: string, readonly "spaceId"?: string }
export const ChildCustomContent = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the child custom content." })), "status": Schema.optionalKey(OnlyArchivedAndCurrentContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the custom content." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "Custom content type." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the custom content is in." })) })
export type ChildrenResponse = { readonly "id"?: string, readonly "status"?: OnlyArchivedAndCurrentContentStatus, readonly "title"?: string, readonly "type"?: string, readonly "spaceId"?: string, readonly "childPosition"?: never }
export const ChildrenResponse = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the child content." })), "status": Schema.optionalKey(OnlyArchivedAndCurrentContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the child content." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "Hierarchical content type (database/embed/folder/page/whiteboard)." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the content is in." })), "childPosition": Schema.optionalKey(Schema.Never) })
export type DescendantsResponse = { readonly "id"?: string, readonly "status"?: OnlyArchivedAndCurrentContentStatus, readonly "title"?: string, readonly "type"?: string, readonly "parentId"?: string, readonly "depth"?: number, readonly "childPosition"?: never }
export const DescendantsResponse = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the descendant." })), "status": Schema.optionalKey(OnlyArchivedAndCurrentContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the descendant." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "Hierarchical content type (database/embed/folder/page/whiteboard)." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content." })), "depth": Schema.optionalKey(Schema.Number.annotate({ "description": "Depth of the descendant in the content tree relative to the content specified in the request.", "format": "int32" }).check(Schema.isInt())), "childPosition": Schema.optionalKey(Schema.Never) })
export type PermittedOperationsResponse = { readonly "operations"?: ReadonlyArray<Operation> }
export const PermittedOperationsResponse = Schema.Struct({ "operations": Schema.optionalKey(Schema.Array(Operation)) }).annotate({ "description": "The list of operations permitted on entity." })
export type PageNestedBodyWrite = { readonly "storage"?: PageBodyWrite, readonly "atlas_doc_format"?: PageBodyWrite, readonly "wiki"?: PageBodyWrite }
export const PageNestedBodyWrite = Schema.Struct({ "storage": Schema.optionalKey(PageBodyWrite), "atlas_doc_format": Schema.optionalKey(PageBodyWrite), "wiki": Schema.optionalKey(PageBodyWrite) }).annotate({ "description": "Body of the page. Only one body format should be specified as the property\nfor this object, e.g. `storage`." })
export type BlogPostNestedBodyWrite = { readonly "storage"?: BlogPostBodyWrite, readonly "atlas_doc_format"?: BlogPostBodyWrite, readonly "wiki"?: BlogPostBodyWrite }
export const BlogPostNestedBodyWrite = Schema.Struct({ "storage": Schema.optionalKey(BlogPostBodyWrite), "atlas_doc_format": Schema.optionalKey(BlogPostBodyWrite), "wiki": Schema.optionalKey(BlogPostBodyWrite) }).annotate({ "description": "Body of the blog post. Only one body format should be specified as the property\nfor this object, e.g. `storage`." })
export type CommentNestedBodyWrite = { readonly "storage"?: CommentBodyWrite, readonly "atlas_doc_format"?: CommentBodyWrite, readonly "wiki"?: CommentBodyWrite }
export const CommentNestedBodyWrite = Schema.Struct({ "storage": Schema.optionalKey(CommentBodyWrite), "atlas_doc_format": Schema.optionalKey(CommentBodyWrite), "wiki": Schema.optionalKey(CommentBodyWrite) }).annotate({ "description": "Body of the comment. Only one body format should be specified as the property\nfor this object, e.g. `storage`." })
export type CustomContentNestedBodyWrite = { readonly "storage"?: CustomContentBodyWrite, readonly "atlas_doc_format"?: CustomContentBodyWrite, readonly "raw"?: CustomContentBodyWrite }
export const CustomContentNestedBodyWrite = Schema.Struct({ "storage": Schema.optionalKey(CustomContentBodyWrite), "atlas_doc_format": Schema.optionalKey(CustomContentBodyWrite), "raw": Schema.optionalKey(CustomContentBodyWrite) }).annotate({ "description": "Body of the custom content. Only one body format should be specified as the property\nfor this object, e.g. `storage`." })
export type Ancestor = { readonly "id"?: string, readonly "type"?: AncestorType }
export const Ancestor = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the ancestor" })), "type": Schema.optionalKey(AncestorType) })
export type RedactionSectionResponse = { readonly "redactions"?: ReadonlyArray<RedactionPointerResponse> }
export const RedactionSectionResponse = Schema.Struct({ "redactions": Schema.optionalKey(Schema.Array(RedactionPointerResponse).annotate({ "description": "List of redactions that were applied to this section" })) })
export type BulkTransitionRoleAssignment = { readonly "permissionCombinationId": string, readonly "principalTypeAssignments": ReadonlyArray<BulkTransitionPrincipalTypeAssignment> }
export const BulkTransitionRoleAssignment = Schema.Struct({ "permissionCombinationId": Schema.String.annotate({ "description": "The ID of the permission combination." }), "principalTypeAssignments": Schema.Array(BulkTransitionPrincipalTypeAssignment).annotate({ "description": "List of principal type assignments." }) })
export type BulkTransitionSpaceSelection = { readonly "spaceType": "ALL" | "ALL_EXCEPT_PERSONAL" | "ALL_EXCEPT_SPECIFIC" | "PERSONAL" | "SPECIFIC", readonly "selectedSpaces"?: ReadonlyArray<BulkTransitionSpaceTarget> }
export const BulkTransitionSpaceSelection = Schema.Struct({ "spaceType": Schema.Literals(["ALL", "ALL_EXCEPT_PERSONAL", "ALL_EXCEPT_SPECIFIC", "PERSONAL", "SPECIFIC"]).annotate({ "description": "The space selection type." }), "selectedSpaces": Schema.optionalKey(Schema.Array(BulkTransitionSpaceTarget).annotate({ "description": "List of specific spaces. Required when spaceType is SPECIFIC or ALL_EXCEPT_SPECIFIC." })) })
export type BulkTransitionCombinationEntry = { readonly "combinationId": string, readonly "spaceCount": number, readonly "principalCount": number, readonly "permissions": ReadonlyArray<BulkTransitionDecodedPermission>, readonly "principalTypes": ReadonlyArray<"USER" | "GROUP" | "GUEST" | "ANONYMOUS" | "ALL_LICENSED_USERS_USER_CLASS" | "ALL_PRODUCT_ADMINS_USER_CLASS" | "APP" | "TEAM"> }
export const BulkTransitionCombinationEntry = Schema.Struct({ "combinationId": Schema.String.annotate({ "description": "The opaque id identifying this unique combination of space permissions. Pass directly to the bulk role-assignments or access-removals endpoints." }), "spaceCount": Schema.Number.annotate({ "description": "Number of spaces that currently have this combination.", "format": "int64" }).check(Schema.isInt()), "principalCount": Schema.Number.annotate({ "description": "Number of principals (users / groups / etc.) that currently have this combination.", "format": "int64" }).check(Schema.isInt()), "permissions": Schema.Array(BulkTransitionDecodedPermission).annotate({ "description": "The decoded space permissions that make up this combination." }), "principalTypes": Schema.Array(Schema.Literals(["USER", "GROUP", "GUEST", "ANONYMOUS", "ALL_LICENSED_USERS_USER_CLASS", "ALL_PRODUCT_ADMINS_USER_CLASS", "APP", "TEAM"])).annotate({ "description": "The principal types that currently hold this combination and can be reassigned via the\nbulk role-assignments endpoint. Use this to know which `principalType` entries are valid\nto include in the bulk-assign request for this combination." }) })
export type Principal = { readonly "principalType"?: PrincipalType, readonly "principalId"?: string }
export const Principal = Schema.Struct({ "principalType": Schema.optionalKey(PrincipalType), "principalId": Schema.optionalKey(Schema.String.annotate({ "description": "The principal ID." })) }).annotate({ "description": "The principal of the role assignment." })
export type SpaceRole = { readonly "id"?: string, readonly "type"?: RoleType, readonly "name"?: string, readonly "description"?: string, readonly "spacePermissions"?: ReadonlyArray<string> }
export const SpaceRole = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "The identifier for the space role." })), "type": Schema.optionalKey(RoleType), "name": Schema.optionalKey(Schema.String.annotate({ "description": "The name for the space role." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "The description for the space role’s usage." })), "spacePermissions": Schema.optionalKey(Schema.Array(Schema.String).annotate({ "description": "The space permissions the space role is comprised of." })) })
export type UpdateSpaceRoleResponse = { readonly "id"?: string, readonly "type"?: RoleType, readonly "name"?: string, readonly "description"?: string, readonly "taskId"?: string }
export const UpdateSpaceRoleResponse = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Id of the space role" })), "type": Schema.optionalKey(RoleType), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Name of the space role" })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Description for the space role" })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Id of the task to update the space permissions associated with the space role" })) })
export type User = { readonly "displayName"?: string, readonly "timeZone"?: string, readonly "personalSpaceId"?: string, readonly "isExternalCollaborator"?: boolean, readonly "accountStatus"?: AccountStatus, readonly "accountId"?: string, readonly "email"?: string, readonly "accountType"?: AccountType, readonly "publicName"?: string, readonly "profilePicture"?: Icon }
export const User = Schema.Struct({ "displayName": Schema.optionalKey(Schema.String.annotate({ "description": "Display name of the user." })), "timeZone": Schema.optionalKey(Schema.String.annotate({ "description": "Time zone of the user. Depending on the user's privacy\nsetting, this may return null." })), "personalSpaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Space ID of the user's personal space. Returns null, if no personal space for the user." })), "isExternalCollaborator": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the user is an external collaborator." })), "accountStatus": Schema.optionalKey(AccountStatus), "accountId": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID of the user." })), "email": Schema.optionalKey(Schema.String.annotate({ "description": "The email address of the user. Depending on the user's privacy setting, this may return an empty string." })), "accountType": Schema.optionalKey(AccountType), "publicName": Schema.optionalKey(Schema.String.annotate({ "description": "Public name of the user." })), "profilePicture": Schema.optionalKey(Icon) })
export type ContentProperty = { readonly "id"?: string, readonly "key"?: string, readonly "value"?: Schema.Json, readonly "version"?: Version }
export const ContentProperty = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the property" })), "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the property" })), "value": Schema.optionalKey(Schema.Json.annotate({ "description": "Value of the property. Must be a valid JSON value." })), "version": Schema.optionalKey(Version) })
export type AttachmentBulk = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "createdAt"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "customContentId"?: string, readonly "mediaType"?: string, readonly "mediaTypeDescription"?: string, readonly "comment"?: string, readonly "fileId"?: string, readonly "fileSize"?: number, readonly "webuiLink"?: string, readonly "downloadLink"?: string, readonly "version"?: Version, readonly "_links"?: AttachmentLinks }
export const AttachmentBulk = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the attachment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the attachment was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page.\n\nNote: This is only returned if the attachment has a container that is a page." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing blog post.\n\nNote: This is only returned if the attachment has a container that is a blog post." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing custom content.\n\nNote: This is only returned if the attachment has a container that is custom content." })), "mediaType": Schema.optionalKey(Schema.String.annotate({ "description": "Media Type for the attachment." })), "mediaTypeDescription": Schema.optionalKey(Schema.String.annotate({ "description": "Media Type description for the attachment." })), "comment": Schema.optionalKey(Schema.String.annotate({ "description": "Comment for the attachment." })), "fileId": Schema.optionalKey(Schema.String.annotate({ "description": "File ID of the attachment. This is the ID referenced in `atlas_doc_format` bodies and is distinct from the attachment ID." })), "fileSize": Schema.optionalKey(Schema.Number.annotate({ "description": "File size of the attachment.", "format": "int64" }).check(Schema.isInt())), "webuiLink": Schema.optionalKey(Schema.String.annotate({ "description": "WebUI link of the attachment." })), "downloadLink": Schema.optionalKey(Schema.String.annotate({ "description": "Download link of the attachment." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(AttachmentLinks) })
export type Task = { readonly "id"?: string, readonly "localId"?: string, readonly "spaceId"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "status"?: "complete" | "incomplete", readonly "body"?: TaskBodySingle, readonly "createdBy"?: string, readonly "assignedTo"?: string, readonly "completedBy"?: string, readonly "createdAt"?: string, readonly "updatedAt"?: string, readonly "dueAt"?: string, readonly "completedAt"?: string }
export const Task = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the task." })), "localId": Schema.optionalKey(Schema.String.annotate({ "description": "Local ID of the task. This ID is local to the corresponding page or blog post." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the task is in." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page the task is in." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post the task is in." })), "status": Schema.optionalKey(Schema.Literals(["complete", "incomplete"]).annotate({ "description": "Status of the task." })), "body": Schema.optionalKey(TaskBodySingle), "createdBy": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID of the user who created this task." })), "assignedTo": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID of the user to whom this task is assigned." })), "completedBy": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID of the user who completed this task." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the task was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "updatedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the task was updated. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "dueAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the task is due. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "completedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the task was completed. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })) })
export type AttachmentCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "attachmentId"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "_links"?: CommentLinks }
export const AttachmentCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "attachmentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the attachment containing the comment." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "_links": Schema.optionalKey(CommentLinks) })
export type CustomContentCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "customContentId"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "_links"?: CommentLinks }
export const CustomContentCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content containing the comment." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "_links": Schema.optionalKey(CommentLinks) })
export type BlogPostBulk = { readonly "id"?: string, readonly "status"?: BlogPostContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "authorId"?: string, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodyBulk, readonly "_links"?: AbstractPageLinks }
export const BlogPostBulk = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post." })), "status": Schema.optionalKey(BlogPostContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the blog post." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the blog post is in." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this blog post originally." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the blog post was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodyBulk), "_links": Schema.optionalKey(AbstractPageLinks) })
export type PageBulk = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: number | null, readonly "authorId"?: string, readonly "ownerId"?: string | null, readonly "lastOwnerId"?: string | null, readonly "subtype"?: string | null, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodyBulk, readonly "_links"?: AbstractPageLinks }
export const PageBulk = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the page." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the page is in." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent page, or null if there is no parent page." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), Schema.Null]).annotate({ "description": "Position of the page within its parent page tree." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this page originally." })), "ownerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owns this page." })), "lastOwnerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owned this page previously, or null if there is no previous owner." })), "subtype": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The subtype of the page." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the page was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodyBulk), "_links": Schema.optionalKey(AbstractPageLinks) })
export type VersionedEntity = { readonly "title"?: string, readonly "id"?: string, readonly "body"?: BodyBulk }
export const VersionedEntity = Schema.Struct({ "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the entity." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the entity." })), "body": Schema.optionalKey(BodyBulk) })
export type PageCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "pageId"?: string, readonly "version"?: Version, readonly "body"?: BodyBulk, readonly "_links"?: CommentLinks }
export const PageCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page the comment is in." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodyBulk), "_links": Schema.optionalKey(CommentLinks) })
export type PageInlineCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "pageId"?: string, readonly "version"?: Version, readonly "body"?: BodyBulk, readonly "resolutionStatus"?: InlineCommentResolutionStatus, readonly "properties"?: InlineCommentProperties, readonly "_links"?: CommentLinks }
export const PageInlineCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page the comment is in." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodyBulk), "resolutionStatus": Schema.optionalKey(InlineCommentResolutionStatus), "properties": Schema.optionalKey(InlineCommentProperties), "_links": Schema.optionalKey(CommentLinks) })
export type BlogPostCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "version"?: Version, readonly "body"?: BodyBulk, readonly "_links"?: CommentLinks }
export const BlogPostCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post the comment is in." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodyBulk), "_links": Schema.optionalKey(CommentLinks) })
export type BlogPostInlineCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "version"?: Version, readonly "body"?: BodyBulk, readonly "resolutionStatus"?: InlineCommentResolutionStatus, readonly "properties"?: InlineCommentProperties, readonly "_links"?: CommentLinks }
export const BlogPostInlineCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post the comment is in." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodyBulk), "resolutionStatus": Schema.optionalKey(InlineCommentResolutionStatus), "properties": Schema.optionalKey(InlineCommentProperties), "_links": Schema.optionalKey(CommentLinks) })
export type ChildrenCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "body"?: BodyBulk, readonly "_links"?: CommentLinks }
export const ChildrenCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment the child comment is in." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodyBulk), "_links": Schema.optionalKey(CommentLinks) })
export type InlineCommentChildrenModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "body"?: BodyBulk, readonly "resolutionStatus"?: InlineCommentResolutionStatus, readonly "properties"?: InlineCommentProperties, readonly "_links"?: CommentLinks }
export const InlineCommentChildrenModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment the child comment is in." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodyBulk), "resolutionStatus": Schema.optionalKey(InlineCommentResolutionStatus), "properties": Schema.optionalKey(InlineCommentProperties), "_links": Schema.optionalKey(CommentLinks) })
export type CustomContentBulk = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "customContentId"?: string, readonly "authorId"?: string, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: CustomContentBodyBulk, readonly "_links"?: CustomContentLinks }
export const CustomContentBulk = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The type of custom content." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the custom content." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the custom content is in.\n\nNote: This is always returned, regardless of if the custom content has a container that is a space." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page.\n\nNote: This is only returned if the custom content has a container that is a page." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing blog post.\n\nNote: This is only returned if the custom content has a container that is a blog post." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing custom content.\n\nNote: This is only returned if the custom content has a container that is custom content." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this custom content originally." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the custom content was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(CustomContentBodyBulk), "_links": Schema.optionalKey(CustomContentLinks) })
export type SpaceBulk = { readonly "id"?: string, readonly "key"?: string, readonly "name"?: string, readonly "type"?: SpaceType, readonly "status"?: SpaceStatus, readonly "authorId"?: string, readonly "spaceOwnerId"?: string, readonly "currentActiveAlias"?: string, readonly "createdAt"?: string, readonly "homepageId"?: string, readonly "description"?: SpaceDescription, readonly "icon"?: SpaceIcon, readonly "_links"?: SpaceLinks }
export const SpaceBulk = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space." })), "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the space." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Name of the space." })), "type": Schema.optionalKey(SpaceType), "status": Schema.optionalKey(SpaceStatus), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this space originally." })), "spaceOwnerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this space." })), "currentActiveAlias": Schema.optionalKey(Schema.String.annotate({ "description": "Currently active alias for a Confluence space." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the space was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "homepageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space's homepage." })), "description": Schema.optionalKey(SpaceDescription), "icon": Schema.optionalKey(SpaceIcon), "_links": Schema.optionalKey(SpaceLinks) })
export type DataPolicySpace = { readonly "id"?: string, readonly "key"?: string, readonly "name"?: string, readonly "description"?: SpaceDescription, readonly "dataPolicy"?: { readonly "anyContentBlocked"?: boolean }, readonly "icon"?: SpaceIcon, readonly "_links"?: SpaceLinks }
export const DataPolicySpace = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space." })), "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the space." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Name of the space." })), "description": Schema.optionalKey(SpaceDescription), "dataPolicy": Schema.optionalKey(Schema.Struct({ "anyContentBlocked": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the space contains any content blocked for (inaccessible to) the requesting client application.", "readOnly": true })) })), "icon": Schema.optionalKey(SpaceIcon), "_links": Schema.optionalKey(SpaceLinks) })
export type CreateFooterCommentModel = { readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "parentCommentId"?: string, readonly "attachmentId"?: string, readonly "customContentId"?: string, readonly "body"?: CommentBodyWrite | CommentNestedBodyWrite }
export const CreateFooterCommentModel = Schema.Struct({ "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing blog post, if intending to create a top level footer comment. Do not provide if creating a reply." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page, if intending to create a top level footer comment. Do not provide if creating a reply." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment, if intending to create a reply. Do not provide if creating a top level comment." })), "attachmentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the attachment, if intending to create a comment against an attachment." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content, if intending to create a comment against a custom content." })), "body": Schema.optionalKey(Schema.Union([CommentBodyWrite, CommentNestedBodyWrite], { mode: "oneOf" })) })
export type CreateInlineCommentModel = { readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "parentCommentId"?: string, readonly "body"?: CommentBodyWrite | CommentNestedBodyWrite, readonly "inlineCommentProperties"?: { readonly "textSelection"?: string, readonly "textSelectionMatchCount"?: number, readonly "textSelectionMatchIndex"?: number } }
export const CreateInlineCommentModel = Schema.Struct({ "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing blog post, if intending to create a top level footer comment. Do not provide if creating a reply." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page, if intending to create a top level footer comment. Do not provide if creating a reply." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment, if intending to create a reply. Do not provide if creating a top level comment." })), "body": Schema.optionalKey(Schema.Union([CommentBodyWrite, CommentNestedBodyWrite], { mode: "oneOf" })), "inlineCommentProperties": Schema.optionalKey(Schema.Struct({ "textSelection": Schema.optionalKey(Schema.String.annotate({ "description": "The text to highlight" })), "textSelectionMatchCount": Schema.optionalKey(Schema.Number.annotate({ "description": "The number of matches for the selected text on the page (should be strictly greater than textSelectionMatchIndex)" }).check(Schema.isInt())), "textSelectionMatchIndex": Schema.optionalKey(Schema.Number.annotate({ "description": "The match index to highlight. This is zero-based. E.g. if you have 3 occurrences of \"hello world\" on a page \nand you want to highlight the second occurrence, you should pass 1 for textSelectionMatchIndex and 3 for textSelectionMatchCount." }).check(Schema.isInt())) }).annotate({ "description": "Object describing the text to highlight on the page/blog post. Only applicable for top level inline comments (not replies) and required in that case." })) })
export type UpdateInlineCommentModel = { readonly "version"?: { readonly "number"?: number, readonly "message"?: string }, readonly "body"?: CommentBodyWrite | CommentNestedBodyWrite, readonly "resolved"?: boolean }
export const UpdateInlineCommentModel = Schema.Struct({ "version": Schema.optionalKey(Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "description": "Number of new version. Should be 1 higher than current version of the comment." }).check(Schema.isInt())), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Optional message store for the new version." })) })), "body": Schema.optionalKey(Schema.Union([CommentBodyWrite, CommentNestedBodyWrite], { mode: "oneOf" })), "resolved": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Resolved state of the comment. Set to true to resolve the comment, set to false to reopen it. If\nmatching the existing state (i.e. true -> resolved or false -> open/reopened) , no change will occur. A dangling\ncomment cannot be updated." })) })
export type RedactionResponse = { readonly "body"?: RedactionSectionResponse, readonly "title"?: RedactionSectionResponse }
export const RedactionResponse = Schema.Struct({ "body": Schema.optionalKey(RedactionSectionResponse), "title": Schema.optionalKey(RedactionSectionResponse) }).annotate({ "description": "Response containing details of all redactions that were applied to the content.\nEach redaction includes a unique ID for restoration, except that code block redactions cannot be restored.\n" })
export type BulkAssignRolesRequest = { readonly "assignments": ReadonlyArray<BulkTransitionRoleAssignment>, readonly "spaceSelection": BulkTransitionSpaceSelection }
export const BulkAssignRolesRequest = Schema.Struct({ "assignments": Schema.Array(BulkTransitionRoleAssignment).annotate({ "description": "List of role assignments to apply." }), "spaceSelection": BulkTransitionSpaceSelection })
export type BulkRemoveAccessRequest = { readonly "permissionCombinationIds": ReadonlyArray<string>, readonly "spaceSelection": BulkTransitionSpaceSelection }
export const BulkRemoveAccessRequest = Schema.Struct({ "permissionCombinationIds": Schema.Array(Schema.String).annotate({ "description": "List of permission combination IDs to remove access for." }), "spaceSelection": BulkTransitionSpaceSelection })
export type ListSpacePermissionCombinationsResponse = { readonly "results": ReadonlyArray<BulkTransitionCombinationEntry>, readonly "generatedAt"?: string | null, readonly "cursor"?: string | null }
export const ListSpacePermissionCombinationsResponse = Schema.Struct({ "results": Schema.Array(BulkTransitionCombinationEntry).annotate({ "description": "One page of unassigned permission combinations, sorted by principalCount descending." }), "generatedAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "ISO-8601 timestamp of the last audit run that populated the combinations table.\nAbsent if the audit task has never run on this tenant." })), "cursor": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Opaque cursor for the next page. Absent when no further results exist." })) })
export type SpaceRoleAssignment = { readonly "principal"?: Principal, readonly "roleId"?: string }
export const SpaceRoleAssignment = Schema.Struct({ "principal": Schema.optionalKey(Principal), "roleId": Schema.optionalKey(Schema.String.annotate({ "description": "The role to which the principal is assigned." })) })
export type FooterCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "attachmentId"?: string, readonly "customContentId"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "body"?: BodySingle, readonly "_links"?: CommentLinks }
export const FooterCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post containing the comment if the comment is on a blog post." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page containing the comment if the comment is on a page." })), "attachmentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the attachment containing the comment if the comment is on an attachment." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content containing the comment if the comment is on a custom content." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment if the comment is a reply." })), "version": Schema.optionalKey(Version), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "body": Schema.optionalKey(BodySingle), "_links": Schema.optionalKey(CommentLinks) })
export type InlineCommentModel = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "resolutionLastModifierId"?: string, readonly "resolutionLastModifiedAt"?: string, readonly "resolutionStatus"?: InlineCommentResolutionStatus, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks, readonly "inlineMarkerRef"?: string, readonly "inlineOriginalSelection"?: string }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "_links"?: CommentLinks }
export const InlineCommentModel = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post containing the comment if the comment is on a blog post." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page containing the comment if the comment is on a page." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment if the comment is a reply." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "resolutionLastModifierId": Schema.optionalKey(Schema.String.annotate({ "description": "Atlassian Account ID of last person who modified the resolve state of the comment. Null until comment is resolved or reopened." })), "resolutionLastModifiedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Timestamp of the last modification to the comment's resolution status. Null until comment is resolved or reopened.", "format": "date-time" })), "resolutionStatus": Schema.optionalKey(InlineCommentResolutionStatus), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks), "inlineMarkerRef": Schema.optionalKey(Schema.String.annotate({ "description": "Property value used to reference the highlighted element in DOM." })), "inlineOriginalSelection": Schema.optionalKey(Schema.String.annotate({ "description": "Text that is highlighted." })) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "_links": Schema.optionalKey(CommentLinks) })
export type AttachmentVersion = { readonly "createdAt"?: string, readonly "message"?: string, readonly "number"?: number, readonly "minorEdit"?: boolean, readonly "authorId"?: string, readonly "attachment"?: VersionedEntity }
export const AttachmentVersion = Schema.Struct({ "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the version was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message associated with the current version." })), "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number.", "format": "int32" }).check(Schema.isInt())), "minorEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Describes if this version is a minor version. Email notifications and activity stream updates are not created for minor versions." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this version." })), "attachment": Schema.optionalKey(VersionedEntity) })
export type BlogPostVersion = { readonly "createdAt"?: string, readonly "message"?: string, readonly "number"?: number, readonly "minorEdit"?: boolean, readonly "authorId"?: string, readonly "blogpost"?: VersionedEntity }
export const BlogPostVersion = Schema.Struct({ "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the version was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message associated with the current version." })), "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number.", "format": "int32" }).check(Schema.isInt())), "minorEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Describes if this version is a minor version. Email notifications and activity stream updates are not created for minor versions." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this version." })), "blogpost": Schema.optionalKey(VersionedEntity) })
export type PageVersion = { readonly "createdAt"?: string, readonly "message"?: string, readonly "number"?: number, readonly "minorEdit"?: boolean, readonly "authorId"?: string, readonly "page"?: VersionedEntity }
export const PageVersion = Schema.Struct({ "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the version was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message associated with the current version." })), "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number.", "format": "int32" }).check(Schema.isInt())), "minorEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Describes if this version is a minor version. Email notifications and activity stream updates are not created for minor versions." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this version." })), "page": Schema.optionalKey(VersionedEntity) })
export type CustomContentVersion = { readonly "createdAt"?: string, readonly "message"?: string, readonly "number"?: number, readonly "minorEdit"?: boolean, readonly "authorId"?: string, readonly "custom"?: VersionedEntity }
export const CustomContentVersion = Schema.Struct({ "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the version was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message associated with the current version." })), "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number.", "format": "int32" }).check(Schema.isInt())), "minorEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Describes if this version is a minor version. Email notifications and activity stream updates are not created for minor versions." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this version." })), "custom": Schema.optionalKey(VersionedEntity) })
export type CommentVersion = { readonly "createdAt"?: string, readonly "message"?: string, readonly "number"?: number, readonly "minorEdit"?: boolean, readonly "authorId"?: string, readonly "comment"?: VersionedEntity }
export const CommentVersion = Schema.Struct({ "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the version was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Message associated with the current version." })), "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number.", "format": "int32" }).check(Schema.isInt())), "minorEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Describes if this version is a minor version. Email notifications and activity stream updates are not created for minor versions." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this version." })), "comment": Schema.optionalKey(VersionedEntity) })
// schemas
export type GetAdminKey200 = AdminKeyResponse
export const GetAdminKey200 = AdminKeyResponse
export type EnableAdminKeyRequestJson = { readonly "durationInMinutes"?: number }
export const EnableAdminKeyRequestJson = Schema.Struct({ "durationInMinutes": Schema.optionalKey(Schema.Number.annotate({ "description": "The requested duration of admin key access in minutes, up to a maximum of 60 minutes, after which the issued admin key will automatically expire.", "format": "int32" }).check(Schema.isInt())) })
export type EnableAdminKey200 = AdminKeyResponse
export const EnableAdminKey200 = AdminKeyResponse
export type GetAttachmentsParams = { readonly "sort"?: AttachmentSortOrder, readonly "cursor"?: string, readonly "status"?: ReadonlyArray<"current" | "archived" | "trashed">, readonly "mediaType"?: string, readonly "filename"?: string, readonly "limit"?: number }
export const GetAttachmentsParams = Schema.Struct({ "sort": Schema.optionalKey(AttachmentSortOrder), "cursor": Schema.optionalKey(Schema.String), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "trashed"]))), "mediaType": Schema.optionalKey(Schema.String), "filename": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetAttachments200 = { readonly "results"?: ReadonlyArray<AttachmentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetAttachments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(AttachmentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Attachment>" })
export type GetAttachmentByIdParams = { readonly "version"?: number, readonly "include-labels"?: boolean, readonly "include-properties"?: boolean, readonly "include-operations"?: boolean, readonly "include-versions"?: boolean, readonly "include-version"?: boolean, readonly "include-collaborators"?: boolean }
export const GetAttachmentByIdParams = Schema.Struct({ "version": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "include-labels": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-versions": Schema.optionalKey(Schema.Boolean), "include-version": Schema.optionalKey(Schema.Boolean), "include-collaborators": Schema.optionalKey(Schema.Boolean) })
export type GetAttachmentById200 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "createdAt"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "customContentId"?: string, readonly "mediaType"?: string, readonly "mediaTypeDescription"?: string, readonly "comment"?: string, readonly "fileId"?: string, readonly "fileSize"?: number, readonly "webuiLink"?: string, readonly "downloadLink"?: string, readonly "version"?: Version, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "_links"?: { readonly "webui"?: string, readonly "download"?: string, readonly "base"?: string } }
export const GetAttachmentById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the attachment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the attachment was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page.\n\nNote: This is only returned if the attachment has a container that is a page." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing blog post.\n\nNote: This is only returned if the attachment has a container that is a blog post." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing custom content.\n\nNote: This is only returned if the attachment has a container that is custom content." })), "mediaType": Schema.optionalKey(Schema.String.annotate({ "description": "Media Type for the attachment." })), "mediaTypeDescription": Schema.optionalKey(Schema.String.annotate({ "description": "Media Type description for the attachment." })), "comment": Schema.optionalKey(Schema.String.annotate({ "description": "Comment for the attachment." })), "fileId": Schema.optionalKey(Schema.String.annotate({ "description": "File ID of the attachment. This is the ID referenced in `atlas_doc_format` bodies and is distinct from the attachment ID." })), "fileSize": Schema.optionalKey(Schema.Number.annotate({ "description": "File size of the attachment.", "format": "int64" }).check(Schema.isInt())), "webuiLink": Schema.optionalKey(Schema.String.annotate({ "description": "WebUI link of the attachment." })), "downloadLink": Schema.optionalKey(Schema.String.annotate({ "description": "Download link of the attachment." })), "version": Schema.optionalKey(Version), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "download": Schema.optionalKey(Schema.String.annotate({ "description": "Download link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type DeleteAttachmentParams = { readonly "purge"?: boolean }
export const DeleteAttachmentParams = Schema.Struct({ "purge": Schema.optionalKey(Schema.Boolean) })
export type GetAttachmentLabelsParams = { readonly "prefix"?: "my" | "team" | "global" | "system", readonly "sort"?: string, readonly "cursor"?: string, readonly "limit"?: number }
export const GetAttachmentLabelsParams = Schema.Struct({ "prefix": Schema.optionalKey(Schema.Literals(["my", "team", "global", "system"])), "sort": Schema.optionalKey(Schema.String), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetAttachmentLabels200 = { readonly "results"?: ReadonlyArray<Label>, readonly "_links"?: MultiEntityLinks }
export const GetAttachmentLabels200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Label>" })
export type GetAttachmentOperations200 = PermittedOperationsResponse
export const GetAttachmentOperations200 = PermittedOperationsResponse
export type GetAttachmentContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetAttachmentContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetAttachmentContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetAttachmentContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreateAttachmentPropertyRequestJson = ContentPropertyCreateRequest
export const CreateAttachmentPropertyRequestJson = ContentPropertyCreateRequest
export type CreateAttachmentProperty200 = ContentProperty
export const CreateAttachmentProperty200 = ContentProperty
export type GetAttachmentContentPropertiesById200 = ContentProperty
export const GetAttachmentContentPropertiesById200 = ContentProperty
export type UpdateAttachmentPropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdateAttachmentPropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdateAttachmentPropertyById200 = ContentProperty
export const UpdateAttachmentPropertyById200 = ContentProperty
export type GetAttachmentVersionsParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: VersionSortOrder }
export const GetAttachmentVersionsParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(VersionSortOrder) })
export type GetAttachmentVersions200 = { readonly "results"?: ReadonlyArray<AttachmentVersion>, readonly "_links"?: MultiEntityLinks }
export const GetAttachmentVersions200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(AttachmentVersion)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Version>" })
export type GetAttachmentVersionDetails200 = DetailedVersion
export const GetAttachmentVersionDetails200 = DetailedVersion
export type GetAttachmentCommentsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: CommentSortOrder, readonly "version"?: number }
export const GetAttachmentCommentsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(CommentSortOrder), "version": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())) })
export type GetAttachmentComments200 = { readonly "results"?: ReadonlyArray<AttachmentCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetAttachmentComments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(AttachmentCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<AttachmentCommentModel>" })
export type GetBlogPostsParams = { readonly "id"?: ReadonlyArray<number>, readonly "space-id"?: ReadonlyArray<number>, readonly "sort"?: BlogPostSortOrder, readonly "status"?: ReadonlyArray<"current" | "deleted" | "trashed">, readonly "title"?: string, readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number }
export const GetBlogPostsParams = Schema.Struct({ "id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "space-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(100))), "sort": Schema.optionalKey(BlogPostSortOrder), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "deleted", "trashed"]))), "title": Schema.optionalKey(Schema.String), "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetBlogPosts200 = { readonly "results"?: ReadonlyArray<BlogPostBulk>, readonly "_links"?: MultiEntityLinks }
export const GetBlogPosts200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(BlogPostBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<BlogPost>" })
export type CreateBlogPostParams = { readonly "private"?: boolean }
export const CreateBlogPostParams = Schema.Struct({ "private": Schema.optionalKey(Schema.Boolean) })
export type CreateBlogPostRequestJson = { readonly "spaceId": string, readonly "status"?: "current" | "draft", readonly "title"?: string, readonly "body"?: BlogPostBodyWrite | BlogPostNestedBodyWrite, readonly "createdAt"?: string }
export const CreateBlogPostRequestJson = Schema.Struct({ "spaceId": Schema.String.annotate({ "description": "ID of the space" }), "status": Schema.optionalKey(Schema.Literals(["current", "draft"]).annotate({ "description": "The status of the blog post, specifies if the blog post will be created as a new blog post or a draft" })), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the blog post, required if creating non-draft." })), "body": Schema.optionalKey(Schema.Union([BlogPostBodyWrite, BlogPostNestedBodyWrite], { mode: "oneOf" })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Created date of the blog post in the format of \"yyyy-MM-ddTHH:mm:ss.SSSZ\"." })) })
export type CreateBlogPost200 = { readonly "id"?: string, readonly "status"?: BlogPostContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "authorId"?: string, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "isFavoritedByCurrentUser"?: boolean, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "tinyui"?: string, readonly "base"?: string } }
export const CreateBlogPost200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post." })), "status": Schema.optionalKey(BlogPostContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the blog post." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the blog post is in." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this blog post originally." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the blog post was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "isFavoritedByCurrentUser": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the blog post has been favorited by the current user." })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "tinyui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetBlogPostByIdParams = { readonly "body-format"?: PrimaryBodyRepresentationSingle, readonly "get-draft"?: boolean, readonly "status"?: ReadonlyArray<"current" | "trashed" | "deleted" | "historical" | "draft">, readonly "version"?: number, readonly "include-labels"?: boolean, readonly "include-properties"?: boolean, readonly "include-operations"?: boolean, readonly "include-likes"?: boolean, readonly "include-versions"?: boolean, readonly "include-version"?: boolean, readonly "include-favorited-by-current-user-status"?: boolean, readonly "include-webresources"?: boolean, readonly "include-collaborators"?: boolean }
export const GetBlogPostByIdParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentationSingle), "get-draft": Schema.optionalKey(Schema.Boolean), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "trashed", "deleted", "historical", "draft"]))), "version": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "include-labels": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-likes": Schema.optionalKey(Schema.Boolean), "include-versions": Schema.optionalKey(Schema.Boolean), "include-version": Schema.optionalKey(Schema.Boolean), "include-favorited-by-current-user-status": Schema.optionalKey(Schema.Boolean), "include-webresources": Schema.optionalKey(Schema.Boolean), "include-collaborators": Schema.optionalKey(Schema.Boolean) })
export type GetBlogPostById200 = { readonly "id"?: string, readonly "status"?: BlogPostContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "authorId"?: string, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "isFavoritedByCurrentUser"?: boolean, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "tinyui"?: string, readonly "base"?: string } }
export const GetBlogPostById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post." })), "status": Schema.optionalKey(BlogPostContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the blog post." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the blog post is in." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this blog post originally." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the blog post was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "isFavoritedByCurrentUser": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the blog post has been favorited by the current user." })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "tinyui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type UpdateBlogPostRequestJson = { readonly "id": string, readonly "status": "current" | "draft", readonly "title": string, readonly "spaceId"?: string, readonly "body": BlogPostBodyWrite | BlogPostNestedBodyWrite, readonly "version": { readonly "number"?: number, readonly "message"?: string }, readonly "createdAt"?: string }
export const UpdateBlogPostRequestJson = Schema.Struct({ "id": Schema.String.annotate({ "description": "Id of the blog post." }), "status": Schema.Literals(["current", "draft"]).annotate({ "description": "The updated status of the blog post.\n\nNote, if you change the status of a blog post from 'current' to 'draft' and it has an existing draft, the existing draft will be deleted in favor of the updated draft.\nAdditionally, this endpoint can be used to restore a 'trashed' or 'deleted' blog post to 'current' status. For restoration, blog post contents will not be updated and only the blog post status will be changed." }), "title": Schema.String.annotate({ "description": "Title of the blog post." }), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing space.\n\nThis currently **does not support moving the blog post to a different space**." })), "body": Schema.Union([BlogPostBodyWrite, BlogPostNestedBodyWrite], { mode: "oneOf" }), "version": Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The new version number of the updated blog post. \nSet this to the current version number plus one, unless you are updating the status to 'draft' which requires a version number of 1.\n\nIf you don't know the current version number, use Get blog post by id.", "format": "int32" }).check(Schema.isInt())), "message": Schema.optionalKey(Schema.String.annotate({ "description": "An optional message to be stored with the version." })) }), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Created date of the blog post in the format of \"yyyy-MM-ddTHH:mm:ss.SSSZ\"." })) })
export type UpdateBlogPost200 = { readonly "id"?: string, readonly "status"?: BlogPostContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "authorId"?: string, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "isFavoritedByCurrentUser"?: boolean, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "tinyui"?: string, readonly "base"?: string } }
export const UpdateBlogPost200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post." })), "status": Schema.optionalKey(BlogPostContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the blog post." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the blog post is in." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this blog post originally." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the blog post was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "isFavoritedByCurrentUser": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the blog post has been favorited by the current user." })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "tinyui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type DeleteBlogPostParams = { readonly "purge"?: boolean, readonly "draft"?: boolean }
export const DeleteBlogPostParams = Schema.Struct({ "purge": Schema.optionalKey(Schema.Boolean), "draft": Schema.optionalKey(Schema.Boolean) })
export type GetBlogpostAttachmentsParams = { readonly "sort"?: AttachmentSortOrder, readonly "cursor"?: string, readonly "status"?: ReadonlyArray<"current" | "archived" | "trashed">, readonly "mediaType"?: string, readonly "filename"?: string, readonly "limit"?: number }
export const GetBlogpostAttachmentsParams = Schema.Struct({ "sort": Schema.optionalKey(AttachmentSortOrder), "cursor": Schema.optionalKey(Schema.String), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "trashed"]))), "mediaType": Schema.optionalKey(Schema.String), "filename": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetBlogpostAttachments200 = { readonly "results"?: ReadonlyArray<AttachmentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetBlogpostAttachments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(AttachmentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Attachment>" })
export type GetCustomContentByTypeInBlogPostParams = { readonly "type": string, readonly "sort"?: CustomContentSortOrder, readonly "cursor"?: string, readonly "limit"?: number, readonly "body-format"?: CustomContentBodyRepresentation }
export const GetCustomContentByTypeInBlogPostParams = Schema.Struct({ "type": Schema.String, "sort": Schema.optionalKey(CustomContentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "body-format": Schema.optionalKey(CustomContentBodyRepresentation) })
export type GetCustomContentByTypeInBlogPost200 = { readonly "results"?: ReadonlyArray<CustomContentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentByTypeInBlogPost200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(CustomContentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<CustomContent>" })
export type GetBlogPostLabelsParams = { readonly "prefix"?: "my" | "team" | "global" | "system", readonly "sort"?: string, readonly "cursor"?: string, readonly "limit"?: number }
export const GetBlogPostLabelsParams = Schema.Struct({ "prefix": Schema.optionalKey(Schema.Literals(["my", "team", "global", "system"])), "sort": Schema.optionalKey(Schema.String), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetBlogPostLabels200 = { readonly "results"?: ReadonlyArray<Label>, readonly "_links"?: MultiEntityLinks }
export const GetBlogPostLabels200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Label>" })
export type GetBlogPostLikeCount200 = { readonly "count"?: number }
export const GetBlogPostLikeCount200 = Schema.Struct({ "count": Schema.optionalKey(Schema.Number.annotate({ "description": "The count number", "format": "int64" }).check(Schema.isInt())) }).annotate({ "title": "Integer" })
export type GetBlogPostLikeUsersParams = { readonly "cursor"?: string, readonly "limit"?: number }
export const GetBlogPostLikeUsersParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetBlogPostLikeUsers200 = { readonly "results"?: ReadonlyArray<Like>, readonly "_links"?: MultiEntityLinks }
export const GetBlogPostLikeUsers200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<String>" })
export type GetBlogpostContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetBlogpostContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetBlogpostContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetBlogpostContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreateBlogpostPropertyRequestJson = ContentPropertyCreateRequest
export const CreateBlogpostPropertyRequestJson = ContentPropertyCreateRequest
export type CreateBlogpostProperty200 = ContentProperty
export const CreateBlogpostProperty200 = ContentProperty
export type GetBlogpostContentPropertiesById200 = ContentProperty
export const GetBlogpostContentPropertiesById200 = ContentProperty
export type UpdateBlogpostPropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdateBlogpostPropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdateBlogpostPropertyById200 = ContentProperty
export const UpdateBlogpostPropertyById200 = ContentProperty
export type GetBlogPostOperations200 = PermittedOperationsResponse
export const GetBlogPostOperations200 = PermittedOperationsResponse
export type GetBlogPostVersionsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: VersionSortOrder }
export const GetBlogPostVersionsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(VersionSortOrder) })
export type GetBlogPostVersions200 = { readonly "results"?: ReadonlyArray<BlogPostVersion>, readonly "_links"?: MultiEntityLinks }
export const GetBlogPostVersions200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(BlogPostVersion)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Version>" })
export type GetBlogPostVersionDetails200 = DetailedVersion
export const GetBlogPostVersionDetails200 = DetailedVersion
export type ConvertContentIdsToContentTypesRequestJson = { readonly "contentIds": ReadonlyArray<string | number> }
export const ConvertContentIdsToContentTypesRequestJson = Schema.Struct({ "contentIds": Schema.Array(Schema.Union([Schema.String, Schema.Number.check(Schema.isFinite())])).annotate({ "description": "The content ids to convert. They may be provided as strings or numbers." }).check(Schema.isMaxLength(100)) })
export type ConvertContentIdsToContentTypes200 = ContentIdToContentTypeResponse
export const ConvertContentIdsToContentTypes200 = ContentIdToContentTypeResponse
export type GetCustomContentByTypeParams = { readonly "type": string, readonly "id"?: ReadonlyArray<number>, readonly "space-id"?: ReadonlyArray<number>, readonly "sort"?: CustomContentSortOrder, readonly "cursor"?: string, readonly "limit"?: number, readonly "body-format"?: CustomContentBodyRepresentation }
export const GetCustomContentByTypeParams = Schema.Struct({ "type": Schema.String, "id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "space-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(100))), "sort": Schema.optionalKey(CustomContentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "body-format": Schema.optionalKey(CustomContentBodyRepresentation) })
export type GetCustomContentByType200 = { readonly "results"?: ReadonlyArray<CustomContentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentByType200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(CustomContentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<CustomContent>" })
export type CreateCustomContentRequestJson = { readonly "type": string, readonly "status"?: "current" | "draft", readonly "spaceId"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "customContentId"?: string, readonly "title": string, readonly "body": CustomContentBodyWrite | CustomContentNestedBodyWrite }
export const CreateCustomContentRequestJson = Schema.Struct({ "type": Schema.String.annotate({ "description": "Type of custom content." }), "status": Schema.optionalKey(Schema.Literals(["current", "draft"]).annotate({ "description": "The status of the custom content. Defaults to `current` when status not provided." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing space." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing Blog Post." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing custom content." })), "title": Schema.String.annotate({ "description": "Title of the custom content." }), "body": Schema.Union([CustomContentBodyWrite, CustomContentNestedBodyWrite], { mode: "oneOf" }) })
export type CreateCustomContent201 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "customContentId"?: string, readonly "authorId"?: string, readonly "createdAt"?: string, readonly "version"?: Version, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "body"?: CustomContentBodySingle, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const CreateCustomContent201 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The type of custom content." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the custom content." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the custom content is in.\n\nNote: This is always returned, regardless of if the custom content has a container that is a space." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page.\n\nNote: This is only returned if the custom content has a container that is a page." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing blog post.\n\nNote: This is only returned if the custom content has a container that is a blog post." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing custom content.\n\nNote: This is only returned if the custom content has a container that is custom content." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this custom content originally." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the custom content was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "body": Schema.optionalKey(CustomContentBodySingle), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetCustomContentByIdParams = { readonly "body-format"?: CustomContentBodyRepresentationSingle, readonly "version"?: number, readonly "include-labels"?: boolean, readonly "include-properties"?: boolean, readonly "include-operations"?: boolean, readonly "include-versions"?: boolean, readonly "include-version"?: boolean, readonly "include-collaborators"?: boolean }
export const GetCustomContentByIdParams = Schema.Struct({ "body-format": Schema.optionalKey(CustomContentBodyRepresentationSingle), "version": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "include-labels": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-versions": Schema.optionalKey(Schema.Boolean), "include-version": Schema.optionalKey(Schema.Boolean), "include-collaborators": Schema.optionalKey(Schema.Boolean) })
export type GetCustomContentById200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "customContentId"?: string, readonly "authorId"?: string, readonly "createdAt"?: string, readonly "version"?: Version, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "body"?: CustomContentBodySingle, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const GetCustomContentById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The type of custom content." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the custom content." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the custom content is in.\n\nNote: This is always returned, regardless of if the custom content has a container that is a space." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page.\n\nNote: This is only returned if the custom content has a container that is a page." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing blog post.\n\nNote: This is only returned if the custom content has a container that is a blog post." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing custom content.\n\nNote: This is only returned if the custom content has a container that is custom content." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this custom content originally." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the custom content was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "body": Schema.optionalKey(CustomContentBodySingle), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type UpdateCustomContentRequestJson = { readonly "id": string, readonly "type": string, readonly "status": "current", readonly "spaceId"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "customContentId"?: string, readonly "title": string, readonly "body": CustomContentBodyWrite | CustomContentNestedBodyWrite, readonly "version": { readonly "number"?: number, readonly "message"?: string } }
export const UpdateCustomContentRequestJson = Schema.Struct({ "id": Schema.String.annotate({ "description": "Id of custom content." }), "type": Schema.String.annotate({ "description": "Type of custom content." }), "status": Schema.Literal("current").annotate({ "description": "The status of the custom content." }), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing space (must be the same as the spaceId of the space the custom content was created in)." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing Blog Post." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing custom content." })), "title": Schema.String.annotate({ "description": "Title of the custom content." }), "body": Schema.Union([CustomContentBodyWrite, CustomContentNestedBodyWrite], { mode: "oneOf" }), "version": Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The version number, must be incremented by one.", "format": "int32" }).check(Schema.isInt())), "message": Schema.optionalKey(Schema.String.annotate({ "description": "An optional message to be stored with the version." })) }) })
export type UpdateCustomContent200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "customContentId"?: string, readonly "authorId"?: string, readonly "createdAt"?: string, readonly "version"?: Version, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "body"?: CustomContentBodySingle, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const UpdateCustomContent200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The type of custom content." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the custom content." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the custom content is in.\n\nNote: This is always returned, regardless of if the custom content has a container that is a space." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing page.\n\nNote: This is only returned if the custom content has a container that is a page." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing blog post.\n\nNote: This is only returned if the custom content has a container that is a blog post." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing custom content.\n\nNote: This is only returned if the custom content has a container that is custom content." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this custom content originally." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the custom content was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "body": Schema.optionalKey(CustomContentBodySingle), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type DeleteCustomContentParams = { readonly "purge"?: boolean }
export const DeleteCustomContentParams = Schema.Struct({ "purge": Schema.optionalKey(Schema.Boolean) })
export type GetCustomContentAttachmentsParams = { readonly "sort"?: AttachmentSortOrder, readonly "cursor"?: string, readonly "status"?: ReadonlyArray<"current" | "archived" | "trashed">, readonly "mediaType"?: string, readonly "filename"?: string, readonly "limit"?: number }
export const GetCustomContentAttachmentsParams = Schema.Struct({ "sort": Schema.optionalKey(AttachmentSortOrder), "cursor": Schema.optionalKey(Schema.String), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "trashed"]))), "mediaType": Schema.optionalKey(Schema.String), "filename": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetCustomContentAttachments200 = { readonly "results"?: ReadonlyArray<AttachmentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentAttachments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(AttachmentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Attachment>" })
export type GetCustomContentCommentsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: CommentSortOrder }
export const GetCustomContentCommentsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(CommentSortOrder) })
export type GetCustomContentComments200 = { readonly "results"?: ReadonlyArray<CustomContentCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentComments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(CustomContentCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<CustomContentCommentModel>" })
export type GetCustomContentLabelsParams = { readonly "prefix"?: "my" | "team" | "global" | "system", readonly "sort"?: string, readonly "cursor"?: string, readonly "limit"?: number }
export const GetCustomContentLabelsParams = Schema.Struct({ "prefix": Schema.optionalKey(Schema.Literals(["my", "team", "global", "system"])), "sort": Schema.optionalKey(Schema.String), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetCustomContentLabels200 = { readonly "results"?: ReadonlyArray<Label>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentLabels200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Label>" })
export type GetCustomContentOperations200 = PermittedOperationsResponse
export const GetCustomContentOperations200 = PermittedOperationsResponse
export type GetCustomContentContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetCustomContentContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetCustomContentContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreateCustomContentPropertyRequestJson = ContentPropertyCreateRequest
export const CreateCustomContentPropertyRequestJson = ContentPropertyCreateRequest
export type CreateCustomContentProperty200 = ContentProperty
export const CreateCustomContentProperty200 = ContentProperty
export type GetCustomContentContentPropertiesById200 = ContentProperty
export const GetCustomContentContentPropertiesById200 = ContentProperty
export type UpdateCustomContentPropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdateCustomContentPropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdateCustomContentPropertyById200 = ContentProperty
export const UpdateCustomContentPropertyById200 = ContentProperty
export type GetLabelsParams = { readonly "label-id"?: ReadonlyArray<number>, readonly "prefix"?: ReadonlyArray<string>, readonly "cursor"?: string, readonly "sort"?: string, readonly "limit"?: number }
export const GetLabelsParams = Schema.Struct({ "label-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()))), "prefix": Schema.optionalKey(Schema.Array(Schema.String)), "cursor": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetLabels200 = { readonly "results"?: ReadonlyArray<Label>, readonly "_links"?: MultiEntityLinks }
export const GetLabels200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Label>" })
export type GetLabelAttachmentsParams = { readonly "sort"?: AttachmentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetLabelAttachmentsParams = Schema.Struct({ "sort": Schema.optionalKey(AttachmentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetLabelAttachments200 = { readonly "results"?: ReadonlyArray<AttachmentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetLabelAttachments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(AttachmentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Attachment>" })
export type GetLabelBlogPostsParams = { readonly "space-id"?: ReadonlyArray<number>, readonly "body-format"?: PrimaryBodyRepresentation, readonly "sort"?: BlogPostSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetLabelBlogPostsParams = Schema.Struct({ "space-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(100))), "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "sort": Schema.optionalKey(BlogPostSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetLabelBlogPosts200 = { readonly "results"?: ReadonlyArray<BlogPostBulk>, readonly "_links"?: MultiEntityLinks }
export const GetLabelBlogPosts200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(BlogPostBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<BlogPost>" })
export type GetLabelPagesParams = { readonly "space-id"?: ReadonlyArray<number>, readonly "body-format"?: PrimaryBodyRepresentation, readonly "sort"?: PageSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetLabelPagesParams = Schema.Struct({ "space-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(100))), "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "sort": Schema.optionalKey(PageSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetLabelPages200 = { readonly "results"?: ReadonlyArray<PageBulk>, readonly "_links"?: MultiEntityLinks }
export const GetLabelPages200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(PageBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Page>" })
export type GetPagesParams = { readonly "id"?: ReadonlyArray<number>, readonly "space-id"?: ReadonlyArray<number>, readonly "sort"?: PageSortOrder, readonly "status"?: ReadonlyArray<"current" | "archived" | "deleted" | "trashed">, readonly "title"?: string, readonly "body-format"?: PrimaryBodyRepresentation, readonly "subtype"?: "live" | "page", readonly "cursor"?: string, readonly "limit"?: number }
export const GetPagesParams = Schema.Struct({ "id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "space-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(100))), "sort": Schema.optionalKey(PageSortOrder), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "deleted", "trashed"]))), "title": Schema.optionalKey(Schema.String), "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "subtype": Schema.optionalKey(Schema.Literals(["live", "page"])), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPages200 = { readonly "results"?: ReadonlyArray<PageBulk>, readonly "_links"?: MultiEntityLinks }
export const GetPages200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(PageBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Page>" })
export type CreatePageParams = { readonly "embedded"?: boolean, readonly "private"?: boolean, readonly "root-level"?: boolean }
export const CreatePageParams = Schema.Struct({ "embedded": Schema.optionalKey(Schema.Boolean), "private": Schema.optionalKey(Schema.Boolean), "root-level": Schema.optionalKey(Schema.Boolean) })
export type CreatePageRequestJson = { readonly "spaceId": string, readonly "status"?: "current" | "draft", readonly "title"?: string, readonly "parentId"?: string, readonly "body"?: PageBodyWrite | PageNestedBodyWrite, readonly "subtype"?: "live" }
export const CreatePageRequestJson = Schema.Struct({ "spaceId": Schema.String.annotate({ "description": "ID of the space." }), "status": Schema.optionalKey(Schema.Literals(["current", "draft"]).annotate({ "description": "The status of the page, published or draft." })), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the page, required if page status is not draft." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "The parent content ID of the page. If the `root-level` query parameter is set to false and a value is \nnot supplied for this parameter, then the space homepage's ID will be used. If the `root-level` query \nparameter is set to true, then a value may not be supplied for this parameter." })), "body": Schema.optionalKey(Schema.Union([PageBodyWrite, PageNestedBodyWrite], { mode: "oneOf" })), "subtype": Schema.optionalKey(Schema.Literal("live").annotate({ "description": "The subtype of the page. Provide the subtype live to create a live doc or no subtype to create a page." })) })
export type CreatePage200 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: number | null, readonly "authorId"?: string, readonly "ownerId"?: string | null, readonly "lastOwnerId"?: string | null, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "isFavoritedByCurrentUser"?: boolean, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "tinyui"?: string, readonly "base"?: string } }
export const CreatePage200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the page." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the page is in." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent page, or null if there is no parent page." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), Schema.Null]).annotate({ "description": "Position of the page within its parent page tree." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this page originally." })), "ownerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owns this page." })), "lastOwnerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owned this page previously, or null if there is no previous owner." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the page was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "isFavoritedByCurrentUser": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the page has been favorited by the current user." })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "tinyui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetPageByIdParams = { readonly "body-format"?: PrimaryBodyRepresentationSingle, readonly "get-draft"?: boolean, readonly "status"?: ReadonlyArray<"current" | "archived" | "trashed" | "deleted" | "historical" | "draft">, readonly "version"?: number, readonly "include-labels"?: boolean, readonly "include-properties"?: boolean, readonly "include-operations"?: boolean, readonly "include-likes"?: boolean, readonly "include-versions"?: boolean, readonly "include-version"?: boolean, readonly "include-favorited-by-current-user-status"?: boolean, readonly "include-webresources"?: boolean, readonly "include-collaborators"?: boolean, readonly "include-direct-children"?: boolean }
export const GetPageByIdParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentationSingle), "get-draft": Schema.optionalKey(Schema.Boolean), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "trashed", "deleted", "historical", "draft"]))), "version": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "include-labels": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-likes": Schema.optionalKey(Schema.Boolean), "include-versions": Schema.optionalKey(Schema.Boolean), "include-version": Schema.optionalKey(Schema.Boolean), "include-favorited-by-current-user-status": Schema.optionalKey(Schema.Boolean), "include-webresources": Schema.optionalKey(Schema.Boolean), "include-collaborators": Schema.optionalKey(Schema.Boolean), "include-direct-children": Schema.optionalKey(Schema.Boolean) })
export type GetPageById200 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: number | null, readonly "authorId"?: string, readonly "ownerId"?: string | null, readonly "lastOwnerId"?: string | null, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "isFavoritedByCurrentUser"?: boolean, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "tinyui"?: string, readonly "base"?: string } }
export const GetPageById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the page." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the page is in." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent page, or null if there is no parent page." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), Schema.Null]).annotate({ "description": "Position of the page within its parent page tree." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this page originally." })), "ownerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owns this page." })), "lastOwnerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owned this page previously, or null if there is no previous owner." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the page was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "isFavoritedByCurrentUser": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the page has been favorited by the current user." })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "tinyui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type UpdatePageRequestJson = { readonly "id": string, readonly "status": "current" | "draft", readonly "title": string, readonly "spaceId"?: string, readonly "parentId"?: string, readonly "ownerId"?: string, readonly "body": PageBodyWrite | PageNestedBodyWrite, readonly "version": { readonly "number"?: number, readonly "message"?: string } }
export const UpdatePageRequestJson = Schema.Struct({ "id": Schema.String.annotate({ "description": "Id of the page." }), "status": Schema.Literals(["current", "draft"]).annotate({ "description": "The updated status of the page.\n\nNote, if you change the status of a page from 'current' to 'draft' and it has an existing draft, the existing draft will be deleted in favor of the updated draft.\nAdditionally, this endpoint can be used to restore a 'trashed' or 'deleted' page to 'current' status. For restoration, page contents will not be updated and only the page status will be changed." }), "title": Schema.String.annotate({ "description": "Title of the page." }), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the containing space.\n\nThis currently **does not support moving the page to a different space**.", "format": "string" })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content.\n\nThis allows the page to be moved under a different parent within the same space.", "format": "string" })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID of the page owner.\n\nThis allows page ownership to be transferred to another user.", "format": "string" })), "body": Schema.Union([PageBodyWrite, PageNestedBodyWrite], { mode: "oneOf" }), "version": Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "description": "The new version of the updated page. \nSet this to the current version number plus one, unless you are updating the status to 'draft' which requires a version number of 1.\n\nIf you don't know the current version number, use Get page by id.", "format": "int32" }).check(Schema.isInt())), "message": Schema.optionalKey(Schema.String.annotate({ "description": "An optional message to be stored with the version." })) }) })
export type UpdatePage200 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: number | null, readonly "authorId"?: string, readonly "ownerId"?: string | null, readonly "lastOwnerId"?: string | null, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "isFavoritedByCurrentUser"?: boolean, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "tinyui"?: string, readonly "base"?: string } }
export const UpdatePage200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the page." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the page is in." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent page, or null if there is no parent page." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), Schema.Null]).annotate({ "description": "Position of the page within its parent page tree." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this page originally." })), "ownerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owns this page." })), "lastOwnerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owned this page previously, or null if there is no previous owner." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the page was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "isFavoritedByCurrentUser": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the page has been favorited by the current user." })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "tinyui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type DeletePageParams = { readonly "purge"?: boolean, readonly "draft"?: boolean }
export const DeletePageParams = Schema.Struct({ "purge": Schema.optionalKey(Schema.Boolean), "draft": Schema.optionalKey(Schema.Boolean) })
export type GetPageAttachmentsParams = { readonly "sort"?: AttachmentSortOrder, readonly "cursor"?: string, readonly "status"?: ReadonlyArray<"current" | "archived" | "trashed">, readonly "mediaType"?: string, readonly "filename"?: string, readonly "limit"?: number }
export const GetPageAttachmentsParams = Schema.Struct({ "sort": Schema.optionalKey(AttachmentSortOrder), "cursor": Schema.optionalKey(Schema.String), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "trashed"]))), "mediaType": Schema.optionalKey(Schema.String), "filename": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPageAttachments200 = { readonly "results"?: ReadonlyArray<AttachmentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetPageAttachments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(AttachmentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Attachment>" })
export type GetCustomContentByTypeInPageParams = { readonly "type": string, readonly "sort"?: CustomContentSortOrder, readonly "cursor"?: string, readonly "limit"?: number, readonly "body-format"?: CustomContentBodyRepresentation }
export const GetCustomContentByTypeInPageParams = Schema.Struct({ "type": Schema.String, "sort": Schema.optionalKey(CustomContentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "body-format": Schema.optionalKey(CustomContentBodyRepresentation) })
export type GetCustomContentByTypeInPage200 = { readonly "results"?: ReadonlyArray<CustomContentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentByTypeInPage200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(CustomContentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<CustomContent>" })
export type GetPageLabelsParams = { readonly "prefix"?: "my" | "team" | "global" | "system", readonly "sort"?: string, readonly "cursor"?: string, readonly "limit"?: number }
export const GetPageLabelsParams = Schema.Struct({ "prefix": Schema.optionalKey(Schema.Literals(["my", "team", "global", "system"])), "sort": Schema.optionalKey(Schema.String), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPageLabels200 = { readonly "results"?: ReadonlyArray<Label>, readonly "_links"?: MultiEntityLinks }
export const GetPageLabels200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Label>" })
export type GetPageLikeCount200 = { readonly "count"?: number }
export const GetPageLikeCount200 = Schema.Struct({ "count": Schema.optionalKey(Schema.Number.annotate({ "description": "The count number", "format": "int64" }).check(Schema.isInt())) }).annotate({ "title": "Integer" })
export type GetPageLikeUsersParams = { readonly "cursor"?: string, readonly "limit"?: number }
export const GetPageLikeUsersParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPageLikeUsers200 = { readonly "results"?: ReadonlyArray<Like>, readonly "_links"?: MultiEntityLinks }
export const GetPageLikeUsers200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<String>" })
export type GetPageOperations200 = PermittedOperationsResponse
export const GetPageOperations200 = PermittedOperationsResponse
export type GetPageContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetPageContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPageContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetPageContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreatePagePropertyRequestJson = ContentPropertyCreateRequest
export const CreatePagePropertyRequestJson = ContentPropertyCreateRequest
export type CreatePageProperty200 = ContentProperty
export const CreatePageProperty200 = ContentProperty
export type GetPageContentPropertiesById200 = ContentProperty
export const GetPageContentPropertiesById200 = ContentProperty
export type UpdatePagePropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdatePagePropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdatePagePropertyById200 = ContentProperty
export const UpdatePagePropertyById200 = ContentProperty
export type PostRedactPageRequestJson = { readonly "createdAt": string, readonly "cleanHistory"?: boolean | null, readonly "versionNumber"?: never, readonly "body"?: { readonly "redactions"?: ReadonlyArray<RedactionPointer> }, readonly "title"?: { readonly "redactions"?: ReadonlyArray<RedactionPointer> } }
export const PostRedactPageRequestJson = Schema.Struct({ "createdAt": Schema.String.annotate({ "description": "Timestamp when the content was last updated.", "format": "date-time" }), "cleanHistory": Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null]).annotate({ "description": "Whether to clean up previous versions containing the redaction. When true, historical versions of the content that contain the redacted text will be squashed." })), "versionNumber": Schema.optionalKey(Schema.Never), "body": Schema.optionalKey(Schema.Struct({ "redactions": Schema.optionalKey(Schema.Array(RedactionPointer)) })), "title": Schema.optionalKey(Schema.Struct({ "redactions": Schema.optionalKey(Schema.Array(RedactionPointer)) })) })
export type PostRedactPage202 = RedactionResponse
export const PostRedactPage202 = RedactionResponse
export type PostRedactBlogRequestJson = { readonly "createdAt": string, readonly "cleanHistory"?: boolean | null, readonly "versionNumber"?: never, readonly "body"?: { readonly "redactions"?: ReadonlyArray<RedactionPointer> }, readonly "title"?: { readonly "redactions"?: ReadonlyArray<RedactionPointer> } }
export const PostRedactBlogRequestJson = Schema.Struct({ "createdAt": Schema.String.annotate({ "description": "Timestamp when the content was last updated.", "format": "date-time" }), "cleanHistory": Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null]).annotate({ "description": "Whether to clean up previous versions containing the redaction. When true, historical versions of the content that contain the redacted text will be squashed." })), "versionNumber": Schema.optionalKey(Schema.Never), "body": Schema.optionalKey(Schema.Struct({ "redactions": Schema.optionalKey(Schema.Array(RedactionPointer)) })), "title": Schema.optionalKey(Schema.Struct({ "redactions": Schema.optionalKey(Schema.Array(RedactionPointer)) })) })
export type PostRedactBlog202 = RedactionResponse
export const PostRedactBlog202 = RedactionResponse
export type UpdatePageTitleRequestJson = { readonly "status": "current" | "draft", readonly "title": string }
export const UpdatePageTitleRequestJson = Schema.Struct({ "status": Schema.Literals(["current", "draft"]).annotate({ "description": "The status of the page, current or draft." }), "title": Schema.String.annotate({ "description": "The updated title for the page" }) })
export type UpdatePageTitle200 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "spaceId"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: number | null, readonly "authorId"?: string, readonly "ownerId"?: string | null, readonly "lastOwnerId"?: string | null, readonly "createdAt"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "isFavoritedByCurrentUser"?: boolean, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "tinyui"?: string, readonly "base"?: string } }
export const UpdatePageTitle200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the page." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the page is in." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent page, or null if there is no parent page." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), Schema.Null]).annotate({ "description": "Position of the page within its parent page tree." })), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this page originally." })), "ownerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owns this page." })), "lastOwnerId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user who owned this page previously, or null if there is no previous owner." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the page was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "isFavoritedByCurrentUser": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the page has been favorited by the current user." })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "tinyui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetPageVersionsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: VersionSortOrder }
export const GetPageVersionsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(VersionSortOrder) })
export type GetPageVersions200 = { readonly "results"?: ReadonlyArray<PageVersion>, readonly "_links"?: MultiEntityLinks }
export const GetPageVersions200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(PageVersion)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Version>" })
export type CreateWhiteboardParams = { readonly "private"?: boolean }
export const CreateWhiteboardParams = Schema.Struct({ "private": Schema.optionalKey(Schema.Boolean) })
export type CreateWhiteboardRequestJson = { readonly "spaceId": string, readonly "title"?: string, readonly "parentId"?: string, readonly "templateKey"?: "2x2-prioritization" | "4ls-retro" | "annual-calendar" | "brainwriting" | "concept-map" | "crazy-8s" | "daily-sync" | "disruptive-brainstorm" | "dot-voting" | "elevator-pitch" | "flow-chart" | "gap-analysis" | "ice-breakers" | "incident-postmortem" | "journey-mapping-kit" | "kanban-board" | "lean-coffee" | "network-of-teams" | "org-chart" | "pi-planning" | "prioritization" | "prioritization-experiment" | "product-roadmap" | "product-vision-board" | "rice" | "sailboat-retro" | "service-blueprint" | "simple-retrospective" | "sprint-planning" | "sticky-note-pack" | "swimlanes" | "team-formation-guide" | "timeline" | "timeline-workflow" | "user-story-map" | "workflow" | "vision-board" | "venn-diagram" | "storyboard" | "action-plan" | "root-cause-analysis" | "executive-summary" | "stakeholder-mapping" | "annual-calendar-2025-2026" | "health-monitor" | "okr-planning" | "swot-analysis" | "poker-planning" | "fishbone-diagram" | "risk-assessment" | "bounded-context" | "hopes-and-fears" | "swimlane-vertical", readonly "locale"?: "de-DE" | "cs-CZ" | "ko-KR" | "fr-FR" | "it-IT" | "ja-JP" | "nl-NL" | "nb-NO" | "da-DK" | "sv-SE" | "fi-FI" | "ru-RU" | "pl-PL" | "tr-TR" | "hu-HU" | "en-GB" | "en-US" | "pt-BR" | "zh-CN" | "zh-TW" | "es-ES" }
export const CreateWhiteboardRequestJson = Schema.Struct({ "spaceId": Schema.String.annotate({ "description": "ID of the space." }), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the whiteboard." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "The parent content ID of the whiteboard." })), "templateKey": Schema.optionalKey(Schema.Literals(["2x2-prioritization", "4ls-retro", "annual-calendar", "brainwriting", "concept-map", "crazy-8s", "daily-sync", "disruptive-brainstorm", "dot-voting", "elevator-pitch", "flow-chart", "gap-analysis", "ice-breakers", "incident-postmortem", "journey-mapping-kit", "kanban-board", "lean-coffee", "network-of-teams", "org-chart", "pi-planning", "prioritization", "prioritization-experiment", "product-roadmap", "product-vision-board", "rice", "sailboat-retro", "service-blueprint", "simple-retrospective", "sprint-planning", "sticky-note-pack", "swimlanes", "team-formation-guide", "timeline", "timeline-workflow", "user-story-map", "workflow", "vision-board", "venn-diagram", "storyboard", "action-plan", "root-cause-analysis", "executive-summary", "stakeholder-mapping", "annual-calendar-2025-2026", "health-monitor", "okr-planning", "swot-analysis", "poker-planning", "fishbone-diagram", "risk-assessment", "bounded-context", "hopes-and-fears", "swimlane-vertical"]).annotate({ "description": "Providing a template key will add that template to the new whiteboard." })), "locale": Schema.optionalKey(Schema.Literals(["de-DE", "cs-CZ", "ko-KR", "fr-FR", "it-IT", "ja-JP", "nl-NL", "nb-NO", "da-DK", "sv-SE", "fi-FI", "ru-RU", "pl-PL", "tr-TR", "hu-HU", "en-GB", "en-US", "pt-BR", "zh-CN", "zh-TW", "es-ES"]).annotate({ "description": "If templateKey is provided, locale will decide which language the template will be created with. If locale is omitted, the user's locale will be used." })) })
export type CreateWhiteboard200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: never, readonly "authorId"?: string, readonly "ownerId"?: string, readonly "createdAt"?: string, readonly "spaceId"?: string, readonly "version"?: Version, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "base"?: string } }
export const CreateWhiteboard200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the whiteboard." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The content type of the object." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the whiteboard." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content, or null if there is no parent content." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Never), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this whiteboard originally." })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this whiteboard." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the whiteboard was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the whiteboard is in." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetWhiteboardByIdParams = { readonly "include-collaborators"?: boolean, readonly "include-direct-children"?: boolean, readonly "include-operations"?: boolean, readonly "include-properties"?: boolean }
export const GetWhiteboardByIdParams = Schema.Struct({ "include-collaborators": Schema.optionalKey(Schema.Boolean), "include-direct-children": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean) })
export type GetWhiteboardById200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: never, readonly "authorId"?: string, readonly "ownerId"?: string, readonly "createdAt"?: string, readonly "spaceId"?: string, readonly "version"?: Version, readonly "_links"?: { readonly "webui"?: string, readonly "editui"?: string, readonly "base"?: string } }
export const GetWhiteboardById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the whiteboard." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The content type of the object." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the whiteboard." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content, or null if there is no parent content." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Never), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this whiteboard originally." })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this whiteboard." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the whiteboard was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the whiteboard is in." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "editui": Schema.optionalKey(Schema.String.annotate({ "description": "Edit UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetWhiteboardContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetWhiteboardContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetWhiteboardContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetWhiteboardContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreateWhiteboardPropertyRequestJson = ContentPropertyCreateRequest
export const CreateWhiteboardPropertyRequestJson = ContentPropertyCreateRequest
export type CreateWhiteboardProperty200 = ContentProperty
export const CreateWhiteboardProperty200 = ContentProperty
export type GetWhiteboardContentPropertiesById200 = ContentProperty
export const GetWhiteboardContentPropertiesById200 = ContentProperty
export type UpdateWhiteboardPropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdateWhiteboardPropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdateWhiteboardPropertyById200 = ContentProperty
export const UpdateWhiteboardPropertyById200 = ContentProperty
export type GetWhiteboardOperations200 = PermittedOperationsResponse
export const GetWhiteboardOperations200 = PermittedOperationsResponse
export type GetWhiteboardDirectChildrenParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: string }
export const GetWhiteboardDirectChildrenParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(Schema.String) })
export type GetWhiteboardDirectChildren200 = { readonly "results"?: ReadonlyArray<ChildrenResponse>, readonly "_links"?: MultiEntityLinks }
export const GetWhiteboardDirectChildren200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ChildrenResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ChildrenResponse>" })
export type GetWhiteboardDescendantsParams = { readonly "limit"?: number, readonly "depth"?: number, readonly "cursor"?: string }
export const GetWhiteboardDescendantsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "depth": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(10))), "cursor": Schema.optionalKey(Schema.String) })
export type GetWhiteboardDescendants200 = { readonly "results"?: ReadonlyArray<DescendantsResponse>, readonly "_links"?: MultiEntityLinks }
export const GetWhiteboardDescendants200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(DescendantsResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<DescendantsResponse>" })
export type GetWhiteboardAncestorsParams = { readonly "limit"?: number }
export const GetWhiteboardAncestorsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetWhiteboardAncestors200 = { readonly "results"?: ReadonlyArray<Ancestor> }
export const GetWhiteboardAncestors200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Ancestor)) }).annotate({ "title": "MultiEntityResult<Ancestor>" })
export type CreateDatabaseParams = { readonly "private"?: boolean }
export const CreateDatabaseParams = Schema.Struct({ "private": Schema.optionalKey(Schema.Boolean) })
export type CreateDatabaseRequestJson = { readonly "spaceId": string, readonly "title"?: string, readonly "parentId"?: string }
export const CreateDatabaseRequestJson = Schema.Struct({ "spaceId": Schema.String.annotate({ "description": "ID of the space." }), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the database." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "The parent content ID of the database." })) })
export type CreateDatabase200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: never, readonly "authorId"?: string, readonly "ownerId"?: string, readonly "createdAt"?: string, readonly "spaceId"?: string, readonly "version"?: Version, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const CreateDatabase200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the database." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The content type of the object." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the database." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content, or null if there is no parent content." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Never), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this database originally." })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this database." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the database was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the database is in." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetDatabaseByIdParams = { readonly "include-collaborators"?: boolean, readonly "include-direct-children"?: boolean, readonly "include-operations"?: boolean, readonly "include-properties"?: boolean }
export const GetDatabaseByIdParams = Schema.Struct({ "include-collaborators": Schema.optionalKey(Schema.Boolean), "include-direct-children": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean) })
export type GetDatabaseById200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: never, readonly "authorId"?: string, readonly "ownerId"?: string, readonly "createdAt"?: string, readonly "spaceId"?: string, readonly "version"?: Version, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const GetDatabaseById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the database." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The content type of the object." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the database." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content, or null if there is no parent content." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Never), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this database originally." })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this database." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the database was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the database is in." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetDatabaseContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetDatabaseContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetDatabaseContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetDatabaseContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreateDatabasePropertyRequestJson = ContentPropertyCreateRequest
export const CreateDatabasePropertyRequestJson = ContentPropertyCreateRequest
export type CreateDatabaseProperty200 = ContentProperty
export const CreateDatabaseProperty200 = ContentProperty
export type GetDatabaseContentPropertiesById200 = ContentProperty
export const GetDatabaseContentPropertiesById200 = ContentProperty
export type UpdateDatabasePropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdateDatabasePropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdateDatabasePropertyById200 = ContentProperty
export const UpdateDatabasePropertyById200 = ContentProperty
export type GetDatabaseOperations200 = PermittedOperationsResponse
export const GetDatabaseOperations200 = PermittedOperationsResponse
export type GetDatabaseDirectChildrenParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: string }
export const GetDatabaseDirectChildrenParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(Schema.String) })
export type GetDatabaseDirectChildren200 = { readonly "results"?: ReadonlyArray<ChildrenResponse>, readonly "_links"?: MultiEntityLinks }
export const GetDatabaseDirectChildren200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ChildrenResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ChildrenResponse>" })
export type GetDatabaseDescendantsParams = { readonly "limit"?: number, readonly "depth"?: number, readonly "cursor"?: string }
export const GetDatabaseDescendantsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "depth": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(10))), "cursor": Schema.optionalKey(Schema.String) })
export type GetDatabaseDescendants200 = { readonly "results"?: ReadonlyArray<DescendantsResponse>, readonly "_links"?: MultiEntityLinks }
export const GetDatabaseDescendants200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(DescendantsResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<DescendantsResponse>" })
export type GetDatabaseAncestorsParams = { readonly "limit"?: number }
export const GetDatabaseAncestorsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetDatabaseAncestors200 = { readonly "results"?: ReadonlyArray<Ancestor> }
export const GetDatabaseAncestors200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Ancestor)) }).annotate({ "title": "MultiEntityResult<Ancestor>" })
export type CreateSmartLinkRequestJson = { readonly "spaceId": string, readonly "title"?: string, readonly "parentId"?: string, readonly "embedUrl"?: string }
export const CreateSmartLinkRequestJson = Schema.Struct({ "spaceId": Schema.String.annotate({ "description": "ID of the space." }), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the Smart Link in the content tree." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "The parent content ID of the Smart Link in the content tree." })), "embedUrl": Schema.optionalKey(Schema.String.annotate({ "description": "The URL that the Smart Link in the content tree should be populated with." })) })
export type CreateSmartLink200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: never, readonly "authorId"?: string, readonly "ownerId"?: string, readonly "createdAt"?: string, readonly "embedUrl"?: string, readonly "spaceId"?: string, readonly "version"?: Version, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const CreateSmartLink200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the Smart Link in the content tree." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The content type of the object." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the Smart Link in the content tree." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content, or null if there is no parent content." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Never), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this Smart Link in the content tree originally." })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this Smart Link in the content tree." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the Smart Link in the content tree was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "embedUrl": Schema.optionalKey(Schema.String.annotate({ "description": "The embedded URL of the Smart Link. If the Smart Link does not have an embedded URL, this property will not be included in the response." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the Smart Link is in." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetSmartLinkByIdParams = { readonly "include-collaborators"?: boolean, readonly "include-direct-children"?: boolean, readonly "include-operations"?: boolean, readonly "include-properties"?: boolean }
export const GetSmartLinkByIdParams = Schema.Struct({ "include-collaborators": Schema.optionalKey(Schema.Boolean), "include-direct-children": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean) })
export type GetSmartLinkById200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: never, readonly "authorId"?: string, readonly "ownerId"?: string, readonly "createdAt"?: string, readonly "embedUrl"?: string, readonly "spaceId"?: string, readonly "version"?: Version, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const GetSmartLinkById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the Smart Link in the content tree." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The content type of the object." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the Smart Link in the content tree." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content, or null if there is no parent content." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Never), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this Smart Link in the content tree originally." })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this Smart Link in the content tree." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the Smart Link in the content tree was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "embedUrl": Schema.optionalKey(Schema.String.annotate({ "description": "The embedded URL of the Smart Link. If the Smart Link does not have an embedded URL, this property will not be included in the response." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the Smart Link is in." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetSmartLinkContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetSmartLinkContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetSmartLinkContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetSmartLinkContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreateSmartLinkPropertyRequestJson = ContentPropertyCreateRequest
export const CreateSmartLinkPropertyRequestJson = ContentPropertyCreateRequest
export type CreateSmartLinkProperty200 = ContentProperty
export const CreateSmartLinkProperty200 = ContentProperty
export type GetSmartLinkContentPropertiesById200 = ContentProperty
export const GetSmartLinkContentPropertiesById200 = ContentProperty
export type UpdateSmartLinkPropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdateSmartLinkPropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdateSmartLinkPropertyById200 = ContentProperty
export const UpdateSmartLinkPropertyById200 = ContentProperty
export type GetSmartLinkOperations200 = PermittedOperationsResponse
export const GetSmartLinkOperations200 = PermittedOperationsResponse
export type GetSmartLinkDirectChildrenParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: string }
export const GetSmartLinkDirectChildrenParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(Schema.String) })
export type GetSmartLinkDirectChildren200 = { readonly "results"?: ReadonlyArray<ChildrenResponse>, readonly "_links"?: MultiEntityLinks }
export const GetSmartLinkDirectChildren200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ChildrenResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ChildrenResponse>" })
export type GetSmartLinkDescendantsParams = { readonly "limit"?: number, readonly "depth"?: number, readonly "cursor"?: string }
export const GetSmartLinkDescendantsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "depth": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(10))), "cursor": Schema.optionalKey(Schema.String) })
export type GetSmartLinkDescendants200 = { readonly "results"?: ReadonlyArray<DescendantsResponse>, readonly "_links"?: MultiEntityLinks }
export const GetSmartLinkDescendants200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(DescendantsResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<DescendantsResponse>" })
export type GetSmartLinkAncestorsParams = { readonly "limit"?: number }
export const GetSmartLinkAncestorsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetSmartLinkAncestors200 = { readonly "results"?: ReadonlyArray<Ancestor> }
export const GetSmartLinkAncestors200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Ancestor)) }).annotate({ "title": "MultiEntityResult<Ancestor>" })
export type CreateFolderRequestJson = { readonly "spaceId": string, readonly "title"?: string, readonly "parentId"?: string }
export const CreateFolderRequestJson = Schema.Struct({ "spaceId": Schema.String.annotate({ "description": "ID of the space." }), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the folder." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "The parent content ID of the folder." })) })
export type CreateFolder200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: never, readonly "authorId"?: string, readonly "ownerId"?: string, readonly "createdAt"?: string, readonly "spaceId"?: string, readonly "version"?: Version, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const CreateFolder200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the folder." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The content type of the object." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the folder." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content, or null if there is no parent content." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Never), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this folder." })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this folder." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the folder was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the folder is in." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetFolderByIdParams = { readonly "include-collaborators"?: boolean, readonly "include-direct-children"?: boolean, readonly "include-operations"?: boolean, readonly "include-properties"?: boolean }
export const GetFolderByIdParams = Schema.Struct({ "include-collaborators": Schema.optionalKey(Schema.Boolean), "include-direct-children": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean) })
export type GetFolderById200 = { readonly "id"?: string, readonly "type"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "parentId"?: string, readonly "parentType"?: ParentContentType, readonly "position"?: never, readonly "authorId"?: string, readonly "ownerId"?: string, readonly "createdAt"?: string, readonly "spaceId"?: string, readonly "version"?: Version, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const GetFolderById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the folder." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The content type of the object." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the folder." })), "parentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent content, or null if there is no parent content." })), "parentType": Schema.optionalKey(ParentContentType), "position": Schema.optionalKey(Schema.Never), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this folder." })), "ownerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this folder." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the folder was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the folder is in." })), "version": Schema.optionalKey(Version), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetFolderContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetFolderContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetFolderContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetFolderContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreateFolderPropertyRequestJson = ContentPropertyCreateRequest
export const CreateFolderPropertyRequestJson = ContentPropertyCreateRequest
export type CreateFolderProperty200 = ContentProperty
export const CreateFolderProperty200 = ContentProperty
export type GetFolderContentPropertiesById200 = ContentProperty
export const GetFolderContentPropertiesById200 = ContentProperty
export type UpdateFolderPropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdateFolderPropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdateFolderPropertyById200 = ContentProperty
export const UpdateFolderPropertyById200 = ContentProperty
export type GetFolderOperations200 = PermittedOperationsResponse
export const GetFolderOperations200 = PermittedOperationsResponse
export type GetFolderDirectChildrenParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: string }
export const GetFolderDirectChildrenParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(Schema.String) })
export type GetFolderDirectChildren200 = { readonly "results"?: ReadonlyArray<ChildrenResponse>, readonly "_links"?: MultiEntityLinks }
export const GetFolderDirectChildren200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ChildrenResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ChildrenResponse>" })
export type GetFolderDescendantsParams = { readonly "limit"?: number, readonly "depth"?: number, readonly "cursor"?: string }
export const GetFolderDescendantsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "depth": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(10))), "cursor": Schema.optionalKey(Schema.String) })
export type GetFolderDescendants200 = { readonly "results"?: ReadonlyArray<DescendantsResponse>, readonly "_links"?: MultiEntityLinks }
export const GetFolderDescendants200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(DescendantsResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<DescendantsResponse>" })
export type GetFolderAncestorsParams = { readonly "limit"?: number }
export const GetFolderAncestorsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetFolderAncestors200 = { readonly "results"?: ReadonlyArray<Ancestor> }
export const GetFolderAncestors200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Ancestor)) }).annotate({ "title": "MultiEntityResult<Ancestor>" })
export type GetPageVersionDetails200 = DetailedVersion
export const GetPageVersionDetails200 = DetailedVersion
export type GetCustomContentVersionsParams = { readonly "body-format"?: CustomContentBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: VersionSortOrder }
export const GetCustomContentVersionsParams = Schema.Struct({ "body-format": Schema.optionalKey(CustomContentBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(VersionSortOrder) })
export type GetCustomContentVersions200 = { readonly "results"?: ReadonlyArray<CustomContentVersion>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentVersions200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(CustomContentVersion)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Version>" })
export type GetCustomContentVersionDetails200 = DetailedVersion
export const GetCustomContentVersionDetails200 = DetailedVersion
export type GetSpacesParams = { readonly "ids"?: ReadonlyArray<number>, readonly "keys"?: ReadonlyArray<string>, readonly "type"?: "global" | "collaboration" | "knowledge_base" | "personal" | "system" | "onboarding" | "xflow_sample_space", readonly "status"?: "current" | "archived", readonly "labels"?: ReadonlyArray<string>, readonly "favorited-by"?: string, readonly "not-favorited-by"?: string, readonly "sort"?: SpaceSortOrder, readonly "description-format"?: SpaceDescriptionBodyRepresentation, readonly "include-icon"?: boolean, readonly "cursor"?: string, readonly "limit"?: number }
export const GetSpacesParams = Schema.Struct({ "ids": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "keys": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(250))), "type": Schema.optionalKey(Schema.Literals(["global", "collaboration", "knowledge_base", "personal", "system", "onboarding", "xflow_sample_space"])), "status": Schema.optionalKey(Schema.Literals(["current", "archived"])), "labels": Schema.optionalKey(Schema.Array(Schema.String)), "favorited-by": Schema.optionalKey(Schema.String), "not-favorited-by": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(SpaceSortOrder), "description-format": Schema.optionalKey(SpaceDescriptionBodyRepresentation), "include-icon": Schema.optionalKey(Schema.Boolean), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetSpaces200 = { readonly "results"?: ReadonlyArray<SpaceBulk>, readonly "_links"?: MultiEntityLinks }
export const GetSpaces200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpaceBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Space>" })
export type CreateSpaceRequestJson = { readonly "name": string, readonly "key"?: string, readonly "alias"?: string, readonly "description"?: { readonly "value"?: string, readonly "representation"?: string }, readonly "roleAssignments"?: ReadonlyArray<{ readonly "principal"?: Principal, readonly "roleId"?: string, readonly [x: string]: Schema.Json }>, readonly "copySpaceAccessConfiguration"?: number, readonly "createPrivateSpace"?: boolean, readonly "templateKey"?: string }
export const CreateSpaceRequestJson = Schema.Struct({ "name": Schema.String.annotate({ "description": "The name of the space to be created." }), "key": Schema.optionalKey(Schema.String.annotate({ "description": "The key for the new space. See [Space Keys](https://support.atlassian.com/confluence-cloud/docs/create-a-space/). If the key property is not provided, the alias property is required to be used instead." })), "alias": Schema.optionalKey(Schema.String.annotate({ "description": "This field will be used as the new identifier for the space in confluence page URLs. If the alias property is not provided, the key property is required to be used instead. Maximum 255 alphanumeric characters in length." })), "description": Schema.optionalKey(Schema.Struct({ "value": Schema.optionalKey(Schema.String.annotate({ "description": "The space description." })), "representation": Schema.optionalKey(Schema.String.annotate({ "description": "The format of the description." })) }).annotate({ "description": "The description of the new/updated space. Note, only the 'plain' representation is currently supported." })), "roleAssignments": Schema.optionalKey(Schema.Array(Schema.StructWithRest(Schema.Struct({ "principal": Schema.optionalKey(Principal), "roleId": Schema.optionalKey(Schema.String.annotate({ "description": "The role to which the principal is assigned." })) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "The role assignments for the new space. If none are provided, the Default Space Roles are applied. If roles are provided, the space is created with exactly the provided set of roles. A private space is created if only the creator is assigned to a role and it’s the Admin role. At least one Admin role assignment must be specified." }))), "copySpaceAccessConfiguration": Schema.optionalKey(Schema.Number.annotate({ "description": "The id of the space to copy the space access configuration from." }).check(Schema.isInt())), "createPrivateSpace": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether to create the space as private." })), "templateKey": Schema.optionalKey(Schema.String.annotate({ "description": "The key of the template to use." })) })
export type CreateSpace201 = { readonly "id"?: string, readonly "key"?: string, readonly "name"?: string, readonly "type"?: SpaceType, readonly "status"?: SpaceStatus, readonly "authorId"?: string, readonly "spaceOwnerId"?: string, readonly "currentActiveAlias"?: string, readonly "createdAt"?: string, readonly "homepageId"?: string, readonly "description"?: SpaceDescription, readonly "icon"?: SpaceIcon, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const CreateSpace201 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space." })), "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the space." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Name of the space." })), "type": Schema.optionalKey(SpaceType), "status": Schema.optionalKey(SpaceStatus), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this space originally." })), "spaceOwnerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this space." })), "currentActiveAlias": Schema.optionalKey(Schema.String.annotate({ "description": "Currently active alias for a Confluence space." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the space was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "homepageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space's homepage." })), "description": Schema.optionalKey(SpaceDescription), "icon": Schema.optionalKey(SpaceIcon), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the space." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetSpaceByIdParams = { readonly "description-format"?: SpaceDescriptionBodyRepresentation, readonly "include-icon"?: boolean, readonly "include-operations"?: boolean, readonly "include-properties"?: boolean, readonly "include-permissions"?: boolean, readonly "include-role-assignments"?: boolean, readonly "include-labels"?: boolean }
export const GetSpaceByIdParams = Schema.Struct({ "description-format": Schema.optionalKey(SpaceDescriptionBodyRepresentation), "include-icon": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-properties": Schema.optionalKey(Schema.Boolean), "include-permissions": Schema.optionalKey(Schema.Boolean), "include-role-assignments": Schema.optionalKey(Schema.Boolean), "include-labels": Schema.optionalKey(Schema.Boolean) })
export type GetSpaceById200 = { readonly "id"?: string, readonly "key"?: string, readonly "name"?: string, readonly "type"?: SpaceType, readonly "status"?: SpaceStatus, readonly "authorId"?: string, readonly "spaceOwnerId"?: string, readonly "createdAt"?: string, readonly "homepageId"?: string, readonly "description"?: SpaceDescription, readonly "icon"?: SpaceIcon, readonly "labels"?: { readonly "results"?: ReadonlyArray<Label>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "properties"?: { readonly "results"?: ReadonlyArray<SpaceProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "permissions"?: { readonly "results"?: ReadonlyArray<SpacePermissionAssignment>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const GetSpaceById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space." })), "key": Schema.optionalKey(Schema.String.annotate({ "description": "Key of the space." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Name of the space." })), "type": Schema.optionalKey(SpaceType), "status": Schema.optionalKey(SpaceStatus), "authorId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who created this space originally." })), "spaceOwnerId": Schema.optionalKey(Schema.String.annotate({ "description": "The account ID of the user who owns this space." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the space was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "homepageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space's homepage." })), "description": Schema.optionalKey(SpaceDescription), "icon": Schema.optionalKey(SpaceIcon), "labels": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpaceProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "permissions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpacePermissionAssignment)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the space." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetBlogPostsInSpaceParams = { readonly "sort"?: BlogPostSortOrder, readonly "status"?: ReadonlyArray<"current" | "deleted" | "trashed">, readonly "title"?: string, readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number }
export const GetBlogPostsInSpaceParams = Schema.Struct({ "sort": Schema.optionalKey(BlogPostSortOrder), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "deleted", "trashed"]))), "title": Schema.optionalKey(Schema.String), "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetBlogPostsInSpace200 = { readonly "results"?: ReadonlyArray<BlogPostBulk>, readonly "_links"?: MultiEntityLinks }
export const GetBlogPostsInSpace200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(BlogPostBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<BlogPost>" })
export type GetSpaceLabelsParams = { readonly "prefix"?: "my" | "team", readonly "sort"?: string, readonly "cursor"?: string, readonly "limit"?: number }
export const GetSpaceLabelsParams = Schema.Struct({ "prefix": Schema.optionalKey(Schema.Literals(["my", "team"])), "sort": Schema.optionalKey(Schema.String), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetSpaceLabels200 = { readonly "results"?: ReadonlyArray<Label>, readonly "_links"?: MultiEntityLinks }
export const GetSpaceLabels200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Label>" })
export type GetSpaceContentLabelsParams = { readonly "prefix"?: "my" | "team", readonly "sort"?: string, readonly "cursor"?: string, readonly "limit"?: number }
export const GetSpaceContentLabelsParams = Schema.Struct({ "prefix": Schema.optionalKey(Schema.Literals(["my", "team"])), "sort": Schema.optionalKey(Schema.String), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetSpaceContentLabels200 = { readonly "results"?: ReadonlyArray<Label>, readonly "_links"?: MultiEntityLinks }
export const GetSpaceContentLabels200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Label)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Label>" })
export type GetCustomContentByTypeInSpaceParams = { readonly "type": string, readonly "cursor"?: string, readonly "limit"?: number, readonly "body-format"?: CustomContentBodyRepresentation }
export const GetCustomContentByTypeInSpaceParams = Schema.Struct({ "type": Schema.String, "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "body-format": Schema.optionalKey(CustomContentBodyRepresentation) })
export type GetCustomContentByTypeInSpace200 = { readonly "results"?: ReadonlyArray<CustomContentBulk>, readonly "_links"?: MultiEntityLinks }
export const GetCustomContentByTypeInSpace200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(CustomContentBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<CustomContent>" })
export type GetSpaceOperations200 = PermittedOperationsResponse
export const GetSpaceOperations200 = PermittedOperationsResponse
export type GetPagesInSpaceParams = { readonly "depth"?: "all" | "root", readonly "sort"?: PageSortOrder, readonly "status"?: ReadonlyArray<"current" | "archived" | "deleted" | "trashed">, readonly "title"?: string, readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number }
export const GetPagesInSpaceParams = Schema.Struct({ "depth": Schema.optionalKey(Schema.Literals(["all", "root"])), "sort": Schema.optionalKey(PageSortOrder), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "deleted", "trashed"]))), "title": Schema.optionalKey(Schema.String), "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPagesInSpace200 = { readonly "results"?: ReadonlyArray<PageBulk>, readonly "_links"?: MultiEntityLinks }
export const GetPagesInSpace200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(PageBulk)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Page>" })
export type GetSpacePropertiesParams = { readonly "key"?: string, readonly "cursor"?: string, readonly "limit"?: number }
export const GetSpacePropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetSpaceProperties200 = { readonly "results"?: ReadonlyArray<SpaceProperty>, readonly "_links"?: MultiEntityLinks }
export const GetSpaceProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpaceProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<SpaceProperty>" })
export type CreateSpacePropertyRequestJson = SpacePropertyCreateRequest
export const CreateSpacePropertyRequestJson = SpacePropertyCreateRequest
export type CreateSpaceProperty201 = SpaceProperty
export const CreateSpaceProperty201 = SpaceProperty
export type GetSpacePropertyById200 = SpaceProperty
export const GetSpacePropertyById200 = SpaceProperty
export type UpdateSpacePropertyByIdRequestJson = SpacePropertyUpdateRequest
export const UpdateSpacePropertyByIdRequestJson = SpacePropertyUpdateRequest
export type UpdateSpacePropertyById200 = SpaceProperty
export const UpdateSpacePropertyById200 = SpaceProperty
export type GetSpacePermissionsAssignmentsParams = { readonly "cursor"?: string, readonly "limit"?: number }
export const GetSpacePermissionsAssignmentsParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetSpacePermissionsAssignments200 = { readonly "results"?: ReadonlyArray<SpacePermissionAssignment>, readonly "_links"?: MultiEntityLinks }
export const GetSpacePermissionsAssignments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpacePermissionAssignment)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<SpacePermissionAssignment>" })
export type GetAvailableSpacePermissionsParams = { readonly "cursor"?: string, readonly "limit"?: number }
export const GetAvailableSpacePermissionsParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetAvailableSpacePermissions200 = { readonly "results"?: ReadonlyArray<SpacePermission>, readonly "_links"?: MultiEntityLinks }
export const GetAvailableSpacePermissions200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpacePermission)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<SpacePermission>" })
export type ListSpacePermissionCombinationsParams = { readonly "cursor"?: string, readonly "limit"?: number }
export const ListSpacePermissionCombinationsParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type ListSpacePermissionCombinations200 = ListSpacePermissionCombinationsResponse
export const ListSpacePermissionCombinations200 = ListSpacePermissionCombinationsResponse
export type GenerateSpacePermissionCombinations202 = BulkTransitionTaskResponse
export const GenerateSpacePermissionCombinations202 = BulkTransitionTaskResponse
export type BulkAssignSpacePermissionRolesRequestJson = BulkAssignRolesRequest
export const BulkAssignSpacePermissionRolesRequestJson = BulkAssignRolesRequest
export type BulkAssignSpacePermissionRoles202 = BulkTransitionTaskResponse
export const BulkAssignSpacePermissionRoles202 = BulkTransitionTaskResponse
export type BulkRemoveSpacePermissionAccessRequestJson = BulkRemoveAccessRequest
export const BulkRemoveSpacePermissionAccessRequestJson = BulkRemoveAccessRequest
export type BulkRemoveSpacePermissionAccess202 = BulkTransitionTaskResponse
export const BulkRemoveSpacePermissionAccess202 = BulkTransitionTaskResponse
export type GetSpacePermissionTransitionTaskStatus200 = BulkTransitionTaskStatusResponse
export const GetSpacePermissionTransitionTaskStatus200 = BulkTransitionTaskStatusResponse
export type GetAvailableSpaceRolesParams = { readonly "space-id"?: string, readonly "role-type"?: string, readonly "principal-id"?: string, readonly "principal-type"?: PrincipalType, readonly "cursor"?: string, readonly "limit"?: number }
export const GetAvailableSpaceRolesParams = Schema.Struct({ "space-id": Schema.optionalKey(Schema.String), "role-type": Schema.optionalKey(Schema.String), "principal-id": Schema.optionalKey(Schema.String), "principal-type": Schema.optionalKey(PrincipalType), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetAvailableSpaceRoles200 = { readonly "results"?: ReadonlyArray<SpaceRole>, readonly "_links"?: MultiEntityLinks }
export const GetAvailableSpaceRoles200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpaceRole)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<SpaceRole>" })
export type CreateSpaceRoleRequestJson = { readonly "name": string, readonly "description": string, readonly "spacePermissions": ReadonlyArray<string> }
export const CreateSpaceRoleRequestJson = Schema.Struct({ "name": Schema.String.annotate({ "description": "Name of the space role" }), "description": Schema.String.annotate({ "description": "Description for the space role" }), "spacePermissions": Schema.Array(Schema.String).annotate({ "description": "The ids of the space permissions associated with the space role. Sample value \"read/space\"; retrieve ids from responses returned by [GET /space-permissions](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space-permissions/#api-space-permissions-get) endpoint" }) })
export type CreateSpaceRole201 = SpaceRole
export const CreateSpaceRole201 = SpaceRole
export type GetSpaceRolesById200 = { readonly "id"?: string, readonly "type"?: RoleType, readonly "name"?: string, readonly "description"?: string, readonly "spacePermissions"?: ReadonlyArray<string>, readonly "_links"?: { readonly "base"?: string } }
export const GetSpaceRolesById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "The identifier for the space role." })), "type": Schema.optionalKey(RoleType), "name": Schema.optionalKey(Schema.String.annotate({ "description": "The name for the space role." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "The description for the space role’s usage." })), "spacePermissions": Schema.optionalKey(Schema.Array(Schema.String).annotate({ "description": "The space permissions the space role is comprised of." })), "_links": Schema.optionalKey(Schema.Struct({ "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type UpdateSpaceRoleRequestJson = { readonly "name": string, readonly "description": string, readonly "spacePermissions": ReadonlyArray<string>, readonly "anonymousReassignmentRoleId"?: string, readonly "guestReassignmentRoleId"?: string }
export const UpdateSpaceRoleRequestJson = Schema.Struct({ "name": Schema.String.annotate({ "description": "Name of the space role" }), "description": Schema.String.annotate({ "description": "Description for the space role" }), "spacePermissions": Schema.Array(Schema.String).annotate({ "description": "The ids of the space permissions associated with the space role. Sample value \"read/space\"; retrieve ids from responses returned by [GET /space-permissions](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space-permissions/#api-space-permissions-get) endpoint" }), "anonymousReassignmentRoleId": Schema.optionalKey(Schema.String.annotate({ "description": "If space anonymous access is assigned to the role being modified, the Id of a role to migrate those assignments to can be specified. Anonymous access role assignments left unchanged if unspecified." })), "guestReassignmentRoleId": Schema.optionalKey(Schema.String.annotate({ "description": "If guests are assigned to the role being modified, the Id of a role to migrate those assignments to can be specified. Guest role assignments left unchanged if unspecified." })) })
export type UpdateSpaceRole202 = UpdateSpaceRoleResponse
export const UpdateSpaceRole202 = UpdateSpaceRoleResponse
export type DeleteSpaceRole202 = DeleteSpaceRoleResponse
export const DeleteSpaceRole202 = DeleteSpaceRoleResponse
export type GetSpaceRoleMode200 = { readonly "mode"?: "PRE_ROLES" | "ROLES_TRANSITION" | "ROLES" }
export const GetSpaceRoleMode200 = Schema.Struct({ "mode": Schema.optionalKey(Schema.Literals(["PRE_ROLES", "ROLES_TRANSITION", "ROLES"]).annotate({ "description": "The space role mode." })) })
export type GetSpaceRoleAssignmentsParams = { readonly "role-id"?: string, readonly "role-type"?: string, readonly "principal-id"?: string, readonly "principal-type"?: PrincipalType, readonly "cursor"?: string, readonly "limit"?: number }
export const GetSpaceRoleAssignmentsParams = Schema.Struct({ "role-id": Schema.optionalKey(Schema.String), "role-type": Schema.optionalKey(Schema.String), "principal-id": Schema.optionalKey(Schema.String), "principal-type": Schema.optionalKey(PrincipalType), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetSpaceRoleAssignments200 = { readonly "results"?: ReadonlyArray<SpaceRoleAssignment>, readonly "_links"?: MultiEntityLinks }
export const GetSpaceRoleAssignments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpaceRoleAssignment)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<SpaceRoleAssignment>" })
export type SetSpaceRoleAssignmentsRequestJson = ReadonlyArray<{ readonly "principal": Principal, readonly "roleId"?: string, readonly [x: string]: Schema.Json }>
export const SetSpaceRoleAssignmentsRequestJson = Schema.Array(Schema.StructWithRest(Schema.Struct({ "principal": Principal, "roleId": Schema.optionalKey(Schema.String.annotate({ "description": "The role to which the principal is assigned." })) }), [Schema.Record(Schema.String, Schema.Json)]))
export type SetSpaceRoleAssignments200 = { readonly "results"?: ReadonlyArray<SpaceRoleAssignment>, readonly "_links"?: MultiEntityLinks }
export const SetSpaceRoleAssignments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(SpaceRoleAssignment)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<SpaceRoleAssignment>" })
export type GetPageFooterCommentsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "status"?: ReadonlyArray<"current" | "archived" | "trashed" | "deleted" | "historical" | "draft">, readonly "sort"?: CommentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetPageFooterCommentsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "trashed", "deleted", "historical", "draft"]))), "sort": Schema.optionalKey(CommentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPageFooterComments200 = { readonly "results"?: ReadonlyArray<PageCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetPageFooterComments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(PageCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<PageCommentModel>" })
export type GetPageInlineCommentsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "status"?: ReadonlyArray<"current" | "archived" | "trashed" | "deleted" | "historical" | "draft">, readonly "resolution-status"?: ReadonlyArray<"resolved" | "open" | "dangling" | "reopened">, readonly "sort"?: CommentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetPageInlineCommentsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "archived", "trashed", "deleted", "historical", "draft"]))), "resolution-status": Schema.optionalKey(Schema.Array(Schema.Literals(["resolved", "open", "dangling", "reopened"]))), "sort": Schema.optionalKey(CommentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPageInlineComments200 = { readonly "results"?: ReadonlyArray<PageInlineCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetPageInlineComments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(PageInlineCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<PageInlineCommentModel>" })
export type GetBlogPostFooterCommentsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "status"?: ReadonlyArray<"current" | "deleted" | "trashed" | "historical" | "draft">, readonly "sort"?: CommentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetBlogPostFooterCommentsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "deleted", "trashed", "historical", "draft"]))), "sort": Schema.optionalKey(CommentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetBlogPostFooterComments200 = { readonly "results"?: ReadonlyArray<BlogPostCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetBlogPostFooterComments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(BlogPostCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<BlogPostCommentModel>" })
export type GetBlogPostInlineCommentsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "status"?: ReadonlyArray<"current" | "deleted" | "trashed" | "historical" | "draft">, readonly "resolution-status"?: ReadonlyArray<"resolved" | "open" | "dangling" | "reopened">, readonly "sort"?: CommentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetBlogPostInlineCommentsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "status": Schema.optionalKey(Schema.Array(Schema.Literals(["current", "deleted", "trashed", "historical", "draft"]))), "resolution-status": Schema.optionalKey(Schema.Array(Schema.Literals(["resolved", "open", "dangling", "reopened"]))), "sort": Schema.optionalKey(CommentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetBlogPostInlineComments200 = { readonly "results"?: ReadonlyArray<BlogPostInlineCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetBlogPostInlineComments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(BlogPostInlineCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<BlogPostInlineCommentModel>" })
export type GetFooterCommentsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "sort"?: CommentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetFooterCommentsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "sort": Schema.optionalKey(CommentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetFooterComments200 = { readonly "results"?: ReadonlyArray<FooterCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetFooterComments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(FooterCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<FooterCommentModel>" })
export type CreateFooterCommentRequestJson = CreateFooterCommentModel
export const CreateFooterCommentRequestJson = CreateFooterCommentModel
export type CreateFooterComment201 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "attachmentId"?: string, readonly "customContentId"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "body"?: BodySingle, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const CreateFooterComment201 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post containing the comment if the comment is on a blog post." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page containing the comment if the comment is on a page." })), "attachmentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the attachment containing the comment if the comment is on an attachment." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content containing the comment if the comment is on a custom content." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment if the comment is a reply." })), "version": Schema.optionalKey(Version), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "body": Schema.optionalKey(BodySingle), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetFooterCommentByIdParams = { readonly "body-format"?: PrimaryBodyRepresentationSingle, readonly "version"?: number, readonly "include-properties"?: boolean, readonly "include-operations"?: boolean, readonly "include-likes"?: boolean, readonly "include-versions"?: boolean, readonly "include-version"?: boolean }
export const GetFooterCommentByIdParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentationSingle), "version": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "include-properties": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-likes": Schema.optionalKey(Schema.Boolean), "include-versions": Schema.optionalKey(Schema.Boolean), "include-version": Schema.optionalKey(Schema.Boolean) })
export type GetFooterCommentById200 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "attachmentId"?: string, readonly "customContentId"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "body"?: BodySingle, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const GetFooterCommentById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post containing the comment if the comment is on a blog post." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page containing the comment if the comment is on a page." })), "attachmentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the attachment containing the comment if the comment is on an attachment." })), "customContentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the custom content containing the comment if the comment is on a custom content." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment if the comment is a reply." })), "version": Schema.optionalKey(Version), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "body": Schema.optionalKey(BodySingle), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type UpdateFooterCommentRequestJson = { readonly "version"?: { readonly "number"?: number, readonly "message"?: string }, readonly "body"?: CommentBodyWrite | CommentNestedBodyWrite, readonly "_links"?: { readonly "base"?: string } }
export const UpdateFooterCommentRequestJson = Schema.Struct({ "version": Schema.optionalKey(Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "description": "Number of new version. Should be 1 higher than current version of the comment." }).check(Schema.isInt())), "message": Schema.optionalKey(Schema.String.annotate({ "description": "Optional message store for the new version." })) })), "body": Schema.optionalKey(Schema.Union([CommentBodyWrite, CommentNestedBodyWrite], { mode: "oneOf" })), "_links": Schema.optionalKey(Schema.Struct({ "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type UpdateFooterComment200 = FooterCommentModel
export const UpdateFooterComment200 = FooterCommentModel
export type GetFooterCommentChildrenParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "sort"?: CommentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetFooterCommentChildrenParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "sort": Schema.optionalKey(CommentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetFooterCommentChildren200 = { readonly "results"?: ReadonlyArray<ChildrenCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetFooterCommentChildren200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ChildrenCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ChildrenCommentModel>" })
export type GetFooterLikeCount200 = { readonly "count"?: number }
export const GetFooterLikeCount200 = Schema.Struct({ "count": Schema.optionalKey(Schema.Number.annotate({ "description": "The count number", "format": "int64" }).check(Schema.isInt())) }).annotate({ "title": "Integer" })
export type GetFooterLikeUsersParams = { readonly "cursor"?: string, readonly "limit"?: number }
export const GetFooterLikeUsersParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetFooterLikeUsers200 = { readonly "results"?: ReadonlyArray<Like>, readonly "_links"?: MultiEntityLinks }
export const GetFooterLikeUsers200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<String>" })
export type GetFooterCommentOperations200 = PermittedOperationsResponse
export const GetFooterCommentOperations200 = PermittedOperationsResponse
export type GetFooterCommentVersionsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: VersionSortOrder }
export const GetFooterCommentVersionsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(VersionSortOrder) })
export type GetFooterCommentVersions200 = { readonly "results"?: ReadonlyArray<CommentVersion>, readonly "_links"?: MultiEntityLinks }
export const GetFooterCommentVersions200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(CommentVersion)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Version>" })
export type GetFooterCommentVersionDetails200 = DetailedVersion
export const GetFooterCommentVersionDetails200 = DetailedVersion
export type GetInlineCommentsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "sort"?: CommentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetInlineCommentsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "sort": Schema.optionalKey(CommentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetInlineComments200 = { readonly "results"?: ReadonlyArray<InlineCommentModel>, readonly "_links"?: MultiEntityLinks }
export const GetInlineComments200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(InlineCommentModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<InlineCommentModel>" })
export type CreateInlineCommentRequestJson = CreateInlineCommentModel
export const CreateInlineCommentRequestJson = CreateInlineCommentModel
export type CreateInlineComment201 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "resolutionLastModifierId"?: string, readonly "resolutionLastModifiedAt"?: string, readonly "resolutionStatus"?: InlineCommentResolutionStatus, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks, readonly "inlineMarkerRef"?: string, readonly "inlineOriginalSelection"?: string }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const CreateInlineComment201 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post containing the comment if the comment is on a blog post." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page containing the comment if the comment is on a page." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment if the comment is a reply." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "resolutionLastModifierId": Schema.optionalKey(Schema.String.annotate({ "description": "Atlassian Account ID of last person who modified the resolve state of the comment. Null until comment is resolved or reopened." })), "resolutionLastModifiedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Timestamp of the last modification to the comment's resolution status. Null until comment is resolved or reopened.", "format": "date-time" })), "resolutionStatus": Schema.optionalKey(InlineCommentResolutionStatus), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks), "inlineMarkerRef": Schema.optionalKey(Schema.String.annotate({ "description": "Property value used to reference the highlighted element in DOM." })), "inlineOriginalSelection": Schema.optionalKey(Schema.String.annotate({ "description": "Text that is highlighted." })) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetInlineCommentByIdParams = { readonly "body-format"?: PrimaryBodyRepresentationSingle, readonly "version"?: number, readonly "include-properties"?: boolean, readonly "include-operations"?: boolean, readonly "include-likes"?: boolean, readonly "include-versions"?: boolean, readonly "include-version"?: boolean }
export const GetInlineCommentByIdParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentationSingle), "version": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "include-properties": Schema.optionalKey(Schema.Boolean), "include-operations": Schema.optionalKey(Schema.Boolean), "include-likes": Schema.optionalKey(Schema.Boolean), "include-versions": Schema.optionalKey(Schema.Boolean), "include-version": Schema.optionalKey(Schema.Boolean) })
export type GetInlineCommentById200 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "resolutionLastModifierId"?: string, readonly "resolutionLastModifiedAt"?: string, readonly "resolutionStatus"?: InlineCommentResolutionStatus, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks, readonly "inlineMarkerRef"?: string, readonly "inlineOriginalSelection"?: string }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const GetInlineCommentById200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post containing the comment if the comment is on a blog post." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page containing the comment if the comment is on a page." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment if the comment is a reply." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "resolutionLastModifierId": Schema.optionalKey(Schema.String.annotate({ "description": "Atlassian Account ID of last person who modified the resolve state of the comment. Null until comment is resolved or reopened." })), "resolutionLastModifiedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Timestamp of the last modification to the comment's resolution status. Null until comment is resolved or reopened.", "format": "date-time" })), "resolutionStatus": Schema.optionalKey(InlineCommentResolutionStatus), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks), "inlineMarkerRef": Schema.optionalKey(Schema.String.annotate({ "description": "Property value used to reference the highlighted element in DOM." })), "inlineOriginalSelection": Schema.optionalKey(Schema.String.annotate({ "description": "Text that is highlighted." })) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type UpdateInlineCommentRequestJson = UpdateInlineCommentModel
export const UpdateInlineCommentRequestJson = UpdateInlineCommentModel
export type UpdateInlineComment200 = { readonly "id"?: string, readonly "status"?: ContentStatus, readonly "title"?: string, readonly "blogPostId"?: string, readonly "pageId"?: string, readonly "parentCommentId"?: string, readonly "version"?: Version, readonly "body"?: BodySingle, readonly "resolutionLastModifierId"?: string, readonly "resolutionLastModifiedAt"?: string, readonly "resolutionStatus"?: InlineCommentResolutionStatus, readonly "properties"?: { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks, readonly "inlineMarkerRef"?: string, readonly "inlineOriginalSelection"?: string }, readonly "operations"?: { readonly "results"?: ReadonlyArray<Operation>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "likes"?: { readonly "results"?: ReadonlyArray<Like>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "versions"?: { readonly "results"?: ReadonlyArray<Version>, readonly "meta"?: OptionalFieldMeta, readonly "_links"?: OptionalFieldLinks }, readonly "_links"?: { readonly "webui"?: string, readonly "base"?: string } }
export const UpdateInlineComment200 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the comment." })), "status": Schema.optionalKey(ContentStatus), "title": Schema.optionalKey(Schema.String.annotate({ "description": "Title of the comment." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post containing the comment if the comment is on a blog post." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page containing the comment if the comment is on a page." })), "parentCommentId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the parent comment if the comment is a reply." })), "version": Schema.optionalKey(Version), "body": Schema.optionalKey(BodySingle), "resolutionLastModifierId": Schema.optionalKey(Schema.String.annotate({ "description": "Atlassian Account ID of last person who modified the resolve state of the comment. Null until comment is resolved or reopened." })), "resolutionLastModifiedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Timestamp of the last modification to the comment's resolution status. Null until comment is resolved or reopened.", "format": "date-time" })), "resolutionStatus": Schema.optionalKey(InlineCommentResolutionStatus), "properties": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks), "inlineMarkerRef": Schema.optionalKey(Schema.String.annotate({ "description": "Property value used to reference the highlighted element in DOM." })), "inlineOriginalSelection": Schema.optionalKey(Schema.String.annotate({ "description": "Text that is highlighted." })) })), "operations": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Operation)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "likes": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "versions": Schema.optionalKey(Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Version)), "meta": Schema.optionalKey(OptionalFieldMeta), "_links": Schema.optionalKey(OptionalFieldLinks) })), "_links": Schema.optionalKey(Schema.Struct({ "webui": Schema.optionalKey(Schema.String.annotate({ "description": "Web UI link of the content." })), "base": Schema.optionalKey(Schema.String.annotate({ "description": "Base url of the Confluence site." })) })) })
export type GetInlineCommentChildrenParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "sort"?: CommentSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetInlineCommentChildrenParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "sort": Schema.optionalKey(CommentSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetInlineCommentChildren200 = { readonly "results"?: ReadonlyArray<InlineCommentChildrenModel>, readonly "_links"?: MultiEntityLinks }
export const GetInlineCommentChildren200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(InlineCommentChildrenModel)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<InlineCommentChildrenModel>" })
export type GetInlineLikeCount200 = { readonly "count"?: number }
export const GetInlineLikeCount200 = Schema.Struct({ "count": Schema.optionalKey(Schema.Number.annotate({ "description": "The count number", "format": "int64" }).check(Schema.isInt())) }).annotate({ "title": "Integer" })
export type GetInlineLikeUsersParams = { readonly "cursor"?: string, readonly "limit"?: number }
export const GetInlineLikeUsersParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetInlineLikeUsers200 = { readonly "results"?: ReadonlyArray<Like>, readonly "_links"?: MultiEntityLinks }
export const GetInlineLikeUsers200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Like)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<String>" })
export type GetInlineCommentOperations200 = PermittedOperationsResponse
export const GetInlineCommentOperations200 = PermittedOperationsResponse
export type GetInlineCommentVersionsParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: VersionSortOrder }
export const GetInlineCommentVersionsParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(VersionSortOrder) })
export type GetInlineCommentVersions200 = { readonly "results"?: ReadonlyArray<CommentVersion>, readonly "_links"?: MultiEntityLinks }
export const GetInlineCommentVersions200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(CommentVersion)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Version>" })
export type GetInlineCommentVersionDetails200 = DetailedVersion
export const GetInlineCommentVersionDetails200 = DetailedVersion
export type GetCommentContentPropertiesParams = { readonly "key"?: string, readonly "sort"?: ContentPropertySortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetCommentContentPropertiesParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(ContentPropertySortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetCommentContentProperties200 = { readonly "results"?: ReadonlyArray<ContentProperty>, readonly "_links"?: MultiEntityLinks }
export const GetCommentContentProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ContentProperty)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ContentProperty>" })
export type CreateCommentPropertyRequestJson = ContentPropertyCreateRequest
export const CreateCommentPropertyRequestJson = ContentPropertyCreateRequest
export type CreateCommentProperty200 = ContentProperty
export const CreateCommentProperty200 = ContentProperty
export type GetCommentContentPropertiesById200 = ContentProperty
export const GetCommentContentPropertiesById200 = ContentProperty
export type UpdateCommentPropertyByIdRequestJson = ContentPropertyUpdateRequest
export const UpdateCommentPropertyByIdRequestJson = ContentPropertyUpdateRequest
export type UpdateCommentPropertyById200 = ContentProperty
export const UpdateCommentPropertyById200 = ContentProperty
export type GetTasksParams = { readonly "body-format"?: PrimaryBodyRepresentation, readonly "include-blank-tasks"?: boolean, readonly "status"?: "complete" | "incomplete", readonly "task-id"?: ReadonlyArray<number>, readonly "space-id"?: ReadonlyArray<number>, readonly "page-id"?: ReadonlyArray<number>, readonly "blogpost-id"?: ReadonlyArray<number>, readonly "created-by"?: ReadonlyArray<string>, readonly "assigned-to"?: ReadonlyArray<string>, readonly "completed-by"?: ReadonlyArray<string>, readonly "created-at-from"?: number, readonly "created-at-to"?: number, readonly "due-at-from"?: number, readonly "due-at-to"?: number, readonly "completed-at-from"?: number, readonly "completed-at-to"?: number, readonly "cursor"?: string, readonly "limit"?: number }
export const GetTasksParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation), "include-blank-tasks": Schema.optionalKey(Schema.Boolean), "status": Schema.optionalKey(Schema.Literals(["complete", "incomplete"])), "task-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "space-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "page-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "blogpost-id": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "created-by": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(250))), "assigned-to": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(250))), "completed-by": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(250))), "created-at-from": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "created-at-to": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "due-at-from": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "due-at-to": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "completed-at-from": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "completed-at-to": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetTasks200 = { readonly "results"?: ReadonlyArray<Task>, readonly "_links"?: MultiEntityLinks }
export const GetTasks200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Task)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Task>" })
export type GetTaskByIdParams = { readonly "body-format"?: PrimaryBodyRepresentation }
export const GetTaskByIdParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation) })
export type GetTaskById200 = Task
export const GetTaskById200 = Task
export type UpdateTaskParams = { readonly "body-format"?: PrimaryBodyRepresentation }
export const UpdateTaskParams = Schema.Struct({ "body-format": Schema.optionalKey(PrimaryBodyRepresentation) })
export type UpdateTaskRequestJson = { readonly "id"?: string, readonly "localId"?: string, readonly "spaceId"?: string, readonly "pageId"?: string, readonly "blogPostId"?: string, readonly "status": "complete" | "incomplete", readonly "createdBy"?: string, readonly "assignedTo"?: string, readonly "completedBy"?: string, readonly "createdAt"?: string, readonly "updatedAt"?: string, readonly "dueAt"?: string, readonly "completedAt"?: string }
export const UpdateTaskRequestJson = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the task." })), "localId": Schema.optionalKey(Schema.String.annotate({ "description": "Local ID of the task. This ID is local to the corresponding page or blog post." })), "spaceId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the space the task is in." })), "pageId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the page the task is in." })), "blogPostId": Schema.optionalKey(Schema.String.annotate({ "description": "ID of the blog post the task is in." })), "status": Schema.Literals(["complete", "incomplete"]).annotate({ "description": "Status of the task." }), "createdBy": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID of the user who created this task." })), "assignedTo": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID of the user to whom this task is assigned." })), "completedBy": Schema.optionalKey(Schema.String.annotate({ "description": "Account ID of the user who completed this task." })), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the task was created. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "updatedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the task was updated. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "dueAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the task is due. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })), "completedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Date and time when the task was completed. In format \"YYYY-MM-DDTHH:mm:ss.sssZ\".", "format": "date-time" })) })
export type UpdateTask200 = Task
export const UpdateTask200 = Task
export type GetChildPagesParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: string }
export const GetChildPagesParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(Schema.String) })
export type GetChildPages200 = { readonly "results"?: ReadonlyArray<ChildPage>, readonly "_links"?: MultiEntityLinks }
export const GetChildPages200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ChildPage)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ChildPage>" })
export type GetChildCustomContentParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: string }
export const GetChildCustomContentParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(Schema.String) })
export type GetChildCustomContent200 = { readonly "results"?: ReadonlyArray<ChildCustomContent>, readonly "_links"?: MultiEntityLinks }
export const GetChildCustomContent200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ChildCustomContent)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ChildCustomContent>" })
export type GetPageDirectChildrenParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "sort"?: string }
export const GetPageDirectChildrenParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "sort": Schema.optionalKey(Schema.String) })
export type GetPageDirectChildren200 = { readonly "results"?: ReadonlyArray<ChildrenResponse>, readonly "_links"?: MultiEntityLinks }
export const GetPageDirectChildren200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(ChildrenResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<ChildrenResponse>" })
export type GetPageAncestorsParams = { readonly "limit"?: number }
export const GetPageAncestorsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetPageAncestors200 = { readonly "results"?: ReadonlyArray<Ancestor>, readonly "_links"?: MultiEntityLinks }
export const GetPageAncestors200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Ancestor)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<Ancestor>" })
export type GetPageDescendantsParams = { readonly "limit"?: number, readonly "depth"?: number, readonly "cursor"?: string }
export const GetPageDescendantsParams = Schema.Struct({ "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))), "depth": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(10))), "cursor": Schema.optionalKey(Schema.String) })
export type GetPageDescendants200 = { readonly "results"?: ReadonlyArray<DescendantsResponse>, readonly "_links"?: MultiEntityLinks }
export const GetPageDescendants200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(DescendantsResponse)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<DescendantsResponse>" })
export type CreateBulkUserLookupRequestJson = { readonly "accountIds": ReadonlyArray<string> }
export const CreateBulkUserLookupRequestJson = Schema.Struct({ "accountIds": Schema.Array(Schema.String).annotate({ "description": "List of accountIds to retrieve user info for." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(250)) })
export type CreateBulkUserLookup200 = { readonly "results"?: ReadonlyArray<User>, readonly "_links"?: MultiEntityLinks }
export const CreateBulkUserLookup200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(User)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<User>" })
export type CheckAccessByEmailRequestJson = { readonly "emails": ReadonlyArray<string> }
export const CheckAccessByEmailRequestJson = Schema.Struct({ "emails": Schema.Array(Schema.String).annotate({ "description": "List of emails to check access to site." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(100)) })
export type CheckAccessByEmail200 = { readonly "emailsWithoutAccess"?: ReadonlyArray<string>, readonly "invalidEmails"?: ReadonlyArray<string> }
export const CheckAccessByEmail200 = Schema.Struct({ "emailsWithoutAccess": Schema.optionalKey(Schema.Array(Schema.String).annotate({ "description": "List of emails that do not have access to site." })), "invalidEmails": Schema.optionalKey(Schema.Array(Schema.String).annotate({ "description": "List of invalid emails provided in the request." })) })
export type InviteByEmailRequestJson = { readonly "emails": ReadonlyArray<string> }
export const InviteByEmailRequestJson = Schema.Struct({ "emails": Schema.Array(Schema.String).annotate({ "description": "List of emails to check access to site." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(100)) })
export type GetDataPolicyMetadata200 = DataPolicyMetadata
export const GetDataPolicyMetadata200 = DataPolicyMetadata
export type GetDataPolicySpacesParams = { readonly "ids"?: ReadonlyArray<number>, readonly "keys"?: ReadonlyArray<string>, readonly "sort"?: SpaceSortOrder, readonly "cursor"?: string, readonly "limit"?: number }
export const GetDataPolicySpacesParams = Schema.Struct({ "ids": Schema.optionalKey(Schema.Array(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())).check(Schema.isMaxLength(250))), "keys": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(250))), "sort": Schema.optionalKey(SpaceSortOrder), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetDataPolicySpaces200 = { readonly "results"?: ReadonlyArray<DataPolicySpace>, readonly "_links"?: MultiEntityLinks }
export const GetDataPolicySpaces200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(DataPolicySpace)), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<DataPolicySpace>" })
export type GetClassificationLevels200 = ReadonlyArray<ClassificationLevel>
export const GetClassificationLevels200 = Schema.Array(ClassificationLevel)
export type GetSpaceDefaultClassificationLevel200 = ClassificationLevel
export const GetSpaceDefaultClassificationLevel200 = ClassificationLevel
export type PutSpaceDefaultClassificationLevelRequestJson = { readonly "id": string }
export const PutSpaceDefaultClassificationLevelRequestJson = Schema.Struct({ "id": Schema.String.annotate({ "description": "The ID of the classification level." }) })
export type GetPageClassificationLevelParams = { readonly "status"?: "current" | "draft" | "archived" }
export const GetPageClassificationLevelParams = Schema.Struct({ "status": Schema.optionalKey(Schema.Literals(["current", "draft", "archived"])) })
export type GetPageClassificationLevel200 = ClassificationLevel
export const GetPageClassificationLevel200 = ClassificationLevel
export type PutPageClassificationLevelRequestJson = { readonly "id": string, readonly "status": "current" | "draft" }
export const PutPageClassificationLevelRequestJson = Schema.Struct({ "id": Schema.String.annotate({ "description": "The ID of the classification level." }), "status": Schema.Literals(["current", "draft"]).annotate({ "description": "Status of the content." }) })
export type PostPageClassificationLevelRequestJson = { readonly "status": "current" | "draft" }
export const PostPageClassificationLevelRequestJson = Schema.Struct({ "status": Schema.Literals(["current", "draft"]).annotate({ "description": "Status of the content." }) })
export type GetBlogPostClassificationLevelParams = { readonly "status"?: "current" | "draft" | "archived" }
export const GetBlogPostClassificationLevelParams = Schema.Struct({ "status": Schema.optionalKey(Schema.Literals(["current", "draft", "archived"])) })
export type GetBlogPostClassificationLevel200 = ClassificationLevel
export const GetBlogPostClassificationLevel200 = ClassificationLevel
export type PutBlogPostClassificationLevelRequestJson = { readonly "id": string, readonly "status": "current" | "draft" }
export const PutBlogPostClassificationLevelRequestJson = Schema.Struct({ "id": Schema.String.annotate({ "description": "The ID of the classification level." }), "status": Schema.Literals(["current", "draft"]).annotate({ "description": "Status of the content." }) })
export type PostBlogPostClassificationLevelRequestJson = { readonly "status": "current" | "draft" }
export const PostBlogPostClassificationLevelRequestJson = Schema.Struct({ "status": Schema.Literals(["current", "draft"]).annotate({ "description": "Status of the content." }) })
export type GetWhiteboardClassificationLevel200 = ClassificationLevel
export const GetWhiteboardClassificationLevel200 = ClassificationLevel
export type PutWhiteboardClassificationLevelRequestJson = { readonly "id": string, readonly "status": "current" }
export const PutWhiteboardClassificationLevelRequestJson = Schema.Struct({ "id": Schema.String.annotate({ "description": "The ID of the classification level." }), "status": Schema.Literal("current").annotate({ "description": "Status of the content." }) })
export type PostWhiteboardClassificationLevelRequestJson = { readonly "status": "current" }
export const PostWhiteboardClassificationLevelRequestJson = Schema.Struct({ "status": Schema.Literal("current").annotate({ "description": "Status of the content." }) })
export type GetDatabaseClassificationLevel200 = ClassificationLevel
export const GetDatabaseClassificationLevel200 = ClassificationLevel
export type PutDatabaseClassificationLevelRequestJson = { readonly "id": string, readonly "status": "current" }
export const PutDatabaseClassificationLevelRequestJson = Schema.Struct({ "id": Schema.String.annotate({ "description": "The ID of the classification level." }), "status": Schema.Literal("current").annotate({ "description": "Status of the content." }) })
export type PostDatabaseClassificationLevelRequestJson = { readonly "status": "current" }
export const PostDatabaseClassificationLevelRequestJson = Schema.Struct({ "status": Schema.Literal("current").annotate({ "description": "Status of the content." }) })
export type GetAttachmentThumbnailByIdParams = { readonly "version"?: number, readonly "height"?: number, readonly "width"?: number }
export const GetAttachmentThumbnailByIdParams = Schema.Struct({ "version": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "height": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "width": Schema.optionalKey(Schema.Number.check(Schema.isInt())) })
export type GetForgeAppPropertiesParams = { readonly "cursor"?: string, readonly "limit"?: number }
export const GetForgeAppPropertiesParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(250))) })
export type GetForgeAppProperties200 = { readonly "results"?: ReadonlyArray<{ readonly "key"?: string, readonly "value"?: {  } }>, readonly "_links"?: MultiEntityLinks }
export const GetForgeAppProperties200 = Schema.Struct({ "results": Schema.optionalKey(Schema.Array(Schema.Struct({ "key": Schema.optionalKey(Schema.String.annotate({ "description": "The key of the property" })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "The value of the property" })) }))), "_links": Schema.optionalKey(MultiEntityLinks) }).annotate({ "title": "MultiEntityResult<AppProperty>" })
export type GetForgeAppProperty200 = { readonly "key"?: string, readonly "value"?: {  } }
export const GetForgeAppProperty200 = Schema.Struct({ "key": Schema.optionalKey(Schema.String.annotate({ "description": "The key of the property" })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "The value of the property" })) })
export type PutForgeAppPropertyRequestJson = {  }
export const PutForgeAppPropertyRequestJson = Schema.Struct({  })

export interface OperationConfig {
  /**
   * Whether or not the response should be included in the value returned from
   * an operation.
   *
   * If set to `true`, a tuple of `[A, HttpClientResponse]` will be returned,
   * where `A` is the success type of the operation.
   *
   * If set to `false`, only the success type of the operation will be returned.
   */
  readonly includeResponse?: boolean | undefined
}

/**
 * A utility type which optionally includes the response in the return result
 * of an operation based upon the value of the `includeResponse` configuration
 * option.
 */
export type WithOptionalResponse<A, Config extends OperationConfig> = Config extends {
  readonly includeResponse: true
} ? [A, HttpClientResponse.HttpClientResponse] : A

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {}
): ConfluenceV2Api => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.json, () => "Unexpected status code"),
      (description) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: response.request,
              response,
              description: typeof description === "string" ? description : JSON.stringify(description),
            }),
          }),
        ),
    )
  const withResponse = <Config extends OperationConfig>(config: Config | undefined) => (
    f: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<any, any>,
  ): (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any> => {
    const withOptionalResponse = (
      config?.includeResponse
        ? (response: HttpClientResponse.HttpClientResponse) => Effect.map(f(response), (a) => [a, response])
        : (response: HttpClientResponse.HttpClientResponse) => f(response)
    ) as any
    return options?.transformClient
      ? (request) =>
          Effect.flatMap(
            Effect.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
            withOptionalResponse
          )
      : (request) => Effect.flatMap(httpClient.execute(request), withOptionalResponse)
  }
  const decodeSuccess =
    <Schema extends Schema.Constraint>(schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response)
  const decodeError =
    <const Tag extends string, Schema extends Schema.Constraint>(tag: Tag, schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(schema)(response),
        (cause) => Effect.fail(ConfluenceV2ApiError(tag, cause, response)),
      )
  return {
    httpClient,
    "getAdminKey": (options) => HttpClientRequest.get(`/admin-key`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAdminKey200),
      orElse: unexpectedStatus
    }))
  ),
    "enableAdminKey": (options) => HttpClientRequest.post(`/admin-key`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(EnableAdminKey200),
      orElse: unexpectedStatus
    }))
  ),
    "disableAdminKey": (options) => HttpClientRequest.delete(`/admin-key`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getAttachments": (options) => HttpClientRequest.get(`/attachments`).pipe(
    HttpClientRequest.setUrlParams({ "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "status": options?.params?.["status"] as any, "mediaType": options?.params?.["mediaType"] as any, "filename": options?.params?.["filename"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachments200),
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentById": (id, options) => HttpClientRequest.get(`/attachments/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "version": options?.params?.["version"] as any, "include-labels": options?.params?.["include-labels"] as any, "include-properties": options?.params?.["include-properties"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-versions": options?.params?.["include-versions"] as any, "include-version": options?.params?.["include-version"] as any, "include-collaborators": options?.params?.["include-collaborators"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachmentById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteAttachment": (id, options) => HttpClientRequest.delete(`/attachments/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "purge": options?.params?.["purge"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentLabels": (id, options) => HttpClientRequest.get(`/attachments/${id}/labels`).pipe(
    HttpClientRequest.setUrlParams({ "prefix": options?.params?.["prefix"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachmentLabels200),
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentOperations": (id, options) => HttpClientRequest.get(`/attachments/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachmentOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentContentProperties": (attachmentId, options) => HttpClientRequest.get(`/attachments/${attachmentId}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachmentContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createAttachmentProperty": (attachmentId, options) => HttpClientRequest.post(`/attachments/${attachmentId}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateAttachmentProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentContentPropertiesById": (attachmentId, propertyId, options) => HttpClientRequest.get(`/attachments/${attachmentId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachmentContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateAttachmentPropertyById": (attachmentId, propertyId, options) => HttpClientRequest.put(`/attachments/${attachmentId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateAttachmentPropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteAttachmentPropertyById": (attachmentId, propertyId, options) => HttpClientRequest.delete(`/attachments/${attachmentId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentVersions": (id, options) => HttpClientRequest.get(`/attachments/${id}/versions`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachmentVersions200),
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentVersionDetails": (attachmentId, versionNumber, options) => HttpClientRequest.get(`/attachments/${attachmentId}/versions/${versionNumber}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachmentVersionDetails200),
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentComments": (id, options) => HttpClientRequest.get(`/attachments/${id}/footer-comments`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any, "version": options?.params?.["version"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAttachmentComments200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPosts": (options) => HttpClientRequest.get(`/blogposts`).pipe(
    HttpClientRequest.setUrlParams({ "id": options?.params?.["id"] as any, "space-id": options?.params?.["space-id"] as any, "sort": options?.params?.["sort"] as any, "status": options?.params?.["status"] as any, "title": options?.params?.["title"] as any, "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPosts200),
      orElse: unexpectedStatus
    }))
  ),
    "createBlogPost": (options) => HttpClientRequest.post(`/blogposts`).pipe(
    HttpClientRequest.setUrlParams({ "private": options.params?.["private"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateBlogPost200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostById": (id, options) => HttpClientRequest.get(`/blogposts/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "get-draft": options?.params?.["get-draft"] as any, "status": options?.params?.["status"] as any, "version": options?.params?.["version"] as any, "include-labels": options?.params?.["include-labels"] as any, "include-properties": options?.params?.["include-properties"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-likes": options?.params?.["include-likes"] as any, "include-versions": options?.params?.["include-versions"] as any, "include-version": options?.params?.["include-version"] as any, "include-favorited-by-current-user-status": options?.params?.["include-favorited-by-current-user-status"] as any, "include-webresources": options?.params?.["include-webresources"] as any, "include-collaborators": options?.params?.["include-collaborators"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateBlogPost": (id, options) => HttpClientRequest.put(`/blogposts/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateBlogPost200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteBlogPost": (id, options) => HttpClientRequest.delete(`/blogposts/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "purge": options?.params?.["purge"] as any, "draft": options?.params?.["draft"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getBlogpostAttachments": (id, options) => HttpClientRequest.get(`/blogposts/${id}/attachments`).pipe(
    HttpClientRequest.setUrlParams({ "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "status": options?.params?.["status"] as any, "mediaType": options?.params?.["mediaType"] as any, "filename": options?.params?.["filename"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogpostAttachments200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentByTypeInBlogPost": (id, options) => HttpClientRequest.get(`/blogposts/${id}/custom-content`).pipe(
    HttpClientRequest.setUrlParams({ "type": options.params["type"] as any, "sort": options.params["sort"] as any, "cursor": options.params["cursor"] as any, "limit": options.params["limit"] as any, "body-format": options.params["body-format"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentByTypeInBlogPost200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostLabels": (id, options) => HttpClientRequest.get(`/blogposts/${id}/labels`).pipe(
    HttpClientRequest.setUrlParams({ "prefix": options?.params?.["prefix"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostLabels200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostLikeCount": (id, options) => HttpClientRequest.get(`/blogposts/${id}/likes/count`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostLikeCount200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostLikeUsers": (id, options) => HttpClientRequest.get(`/blogposts/${id}/likes/users`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostLikeUsers200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogpostContentProperties": (blogpostId, options) => HttpClientRequest.get(`/blogposts/${blogpostId}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogpostContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createBlogpostProperty": (blogpostId, options) => HttpClientRequest.post(`/blogposts/${blogpostId}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateBlogpostProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogpostContentPropertiesById": (blogpostId, propertyId, options) => HttpClientRequest.get(`/blogposts/${blogpostId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogpostContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateBlogpostPropertyById": (blogpostId, propertyId, options) => HttpClientRequest.put(`/blogposts/${blogpostId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateBlogpostPropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteBlogpostPropertyById": (blogpostId, propertyId, options) => HttpClientRequest.delete(`/blogposts/${blogpostId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostOperations": (id, options) => HttpClientRequest.get(`/blogposts/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostVersions": (id, options) => HttpClientRequest.get(`/blogposts/${id}/versions`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostVersions200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostVersionDetails": (blogpostId, versionNumber, options) => HttpClientRequest.get(`/blogposts/${blogpostId}/versions/${versionNumber}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostVersionDetails200),
      orElse: unexpectedStatus
    }))
  ),
    "convertContentIdsToContentTypes": (options) => HttpClientRequest.post(`/content/convert-ids-to-types`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(ConvertContentIdsToContentTypes200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentByType": (options) => HttpClientRequest.get(`/custom-content`).pipe(
    HttpClientRequest.setUrlParams({ "type": options.params["type"] as any, "id": options.params["id"] as any, "space-id": options.params["space-id"] as any, "sort": options.params["sort"] as any, "cursor": options.params["cursor"] as any, "limit": options.params["limit"] as any, "body-format": options.params["body-format"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentByType200),
      orElse: unexpectedStatus
    }))
  ),
    "createCustomContent": (options) => HttpClientRequest.post(`/custom-content`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateCustomContent201),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentById": (id, options) => HttpClientRequest.get(`/custom-content/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "version": options?.params?.["version"] as any, "include-labels": options?.params?.["include-labels"] as any, "include-properties": options?.params?.["include-properties"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-versions": options?.params?.["include-versions"] as any, "include-version": options?.params?.["include-version"] as any, "include-collaborators": options?.params?.["include-collaborators"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateCustomContent": (id, options) => HttpClientRequest.put(`/custom-content/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateCustomContent200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteCustomContent": (id, options) => HttpClientRequest.delete(`/custom-content/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "purge": options?.params?.["purge"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentAttachments": (id, options) => HttpClientRequest.get(`/custom-content/${id}/attachments`).pipe(
    HttpClientRequest.setUrlParams({ "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "status": options?.params?.["status"] as any, "mediaType": options?.params?.["mediaType"] as any, "filename": options?.params?.["filename"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentAttachments200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentComments": (id, options) => HttpClientRequest.get(`/custom-content/${id}/footer-comments`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentComments200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentLabels": (id, options) => HttpClientRequest.get(`/custom-content/${id}/labels`).pipe(
    HttpClientRequest.setUrlParams({ "prefix": options?.params?.["prefix"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentLabels200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentOperations": (id, options) => HttpClientRequest.get(`/custom-content/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentContentProperties": (customContentId, options) => HttpClientRequest.get(`/custom-content/${customContentId}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createCustomContentProperty": (customContentId, options) => HttpClientRequest.post(`/custom-content/${customContentId}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateCustomContentProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentContentPropertiesById": (customContentId, propertyId, options) => HttpClientRequest.get(`/custom-content/${customContentId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateCustomContentPropertyById": (customContentId, propertyId, options) => HttpClientRequest.put(`/custom-content/${customContentId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateCustomContentPropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteCustomContentPropertyById": (customContentId, propertyId, options) => HttpClientRequest.delete(`/custom-content/${customContentId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getLabels": (options) => HttpClientRequest.get(`/labels`).pipe(
    HttpClientRequest.setUrlParams({ "label-id": options?.params?.["label-id"] as any, "prefix": options?.params?.["prefix"] as any, "cursor": options?.params?.["cursor"] as any, "sort": options?.params?.["sort"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetLabels200),
      orElse: unexpectedStatus
    }))
  ),
    "getLabelAttachments": (id, options) => HttpClientRequest.get(`/labels/${id}/attachments`).pipe(
    HttpClientRequest.setUrlParams({ "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetLabelAttachments200),
      orElse: unexpectedStatus
    }))
  ),
    "getLabelBlogPosts": (id, options) => HttpClientRequest.get(`/labels/${id}/blogposts`).pipe(
    HttpClientRequest.setUrlParams({ "space-id": options?.params?.["space-id"] as any, "body-format": options?.params?.["body-format"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetLabelBlogPosts200),
      orElse: unexpectedStatus
    }))
  ),
    "getLabelPages": (id, options) => HttpClientRequest.get(`/labels/${id}/pages`).pipe(
    HttpClientRequest.setUrlParams({ "space-id": options?.params?.["space-id"] as any, "body-format": options?.params?.["body-format"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetLabelPages200),
      orElse: unexpectedStatus
    }))
  ),
    "getPages": (options) => HttpClientRequest.get(`/pages`).pipe(
    HttpClientRequest.setUrlParams({ "id": options?.params?.["id"] as any, "space-id": options?.params?.["space-id"] as any, "sort": options?.params?.["sort"] as any, "status": options?.params?.["status"] as any, "title": options?.params?.["title"] as any, "body-format": options?.params?.["body-format"] as any, "subtype": options?.params?.["subtype"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPages200),
      orElse: unexpectedStatus
    }))
  ),
    "createPage": (options) => HttpClientRequest.post(`/pages`).pipe(
    HttpClientRequest.setUrlParams({ "embedded": options.params?.["embedded"] as any, "private": options.params?.["private"] as any, "root-level": options.params?.["root-level"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreatePage200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageById": (id, options) => HttpClientRequest.get(`/pages/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "get-draft": options?.params?.["get-draft"] as any, "status": options?.params?.["status"] as any, "version": options?.params?.["version"] as any, "include-labels": options?.params?.["include-labels"] as any, "include-properties": options?.params?.["include-properties"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-likes": options?.params?.["include-likes"] as any, "include-versions": options?.params?.["include-versions"] as any, "include-version": options?.params?.["include-version"] as any, "include-favorited-by-current-user-status": options?.params?.["include-favorited-by-current-user-status"] as any, "include-webresources": options?.params?.["include-webresources"] as any, "include-collaborators": options?.params?.["include-collaborators"] as any, "include-direct-children": options?.params?.["include-direct-children"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageById200),
      orElse: unexpectedStatus
    }))
  ),
    "updatePage": (id, options) => HttpClientRequest.put(`/pages/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdatePage200),
      orElse: unexpectedStatus
    }))
  ),
    "deletePage": (id, options) => HttpClientRequest.delete(`/pages/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "purge": options?.params?.["purge"] as any, "draft": options?.params?.["draft"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getPageAttachments": (id, options) => HttpClientRequest.get(`/pages/${id}/attachments`).pipe(
    HttpClientRequest.setUrlParams({ "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "status": options?.params?.["status"] as any, "mediaType": options?.params?.["mediaType"] as any, "filename": options?.params?.["filename"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageAttachments200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentByTypeInPage": (id, options) => HttpClientRequest.get(`/pages/${id}/custom-content`).pipe(
    HttpClientRequest.setUrlParams({ "type": options.params["type"] as any, "sort": options.params["sort"] as any, "cursor": options.params["cursor"] as any, "limit": options.params["limit"] as any, "body-format": options.params["body-format"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentByTypeInPage200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageLabels": (id, options) => HttpClientRequest.get(`/pages/${id}/labels`).pipe(
    HttpClientRequest.setUrlParams({ "prefix": options?.params?.["prefix"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageLabels200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageLikeCount": (id, options) => HttpClientRequest.get(`/pages/${id}/likes/count`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageLikeCount200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageLikeUsers": (id, options) => HttpClientRequest.get(`/pages/${id}/likes/users`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageLikeUsers200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageOperations": (id, options) => HttpClientRequest.get(`/pages/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageContentProperties": (pageId, options) => HttpClientRequest.get(`/pages/${pageId}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createPageProperty": (pageId, options) => HttpClientRequest.post(`/pages/${pageId}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreatePageProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageContentPropertiesById": (pageId, propertyId, options) => HttpClientRequest.get(`/pages/${pageId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updatePagePropertyById": (pageId, propertyId, options) => HttpClientRequest.put(`/pages/${pageId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdatePagePropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deletePagePropertyById": (pageId, propertyId, options) => HttpClientRequest.delete(`/pages/${pageId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "postRedactPage": (id, options) => HttpClientRequest.post(`/pages/${id}/redact`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PostRedactPage202),
      orElse: unexpectedStatus
    }))
  ),
    "postRedactBlog": (id, options) => HttpClientRequest.post(`/blogposts/${id}/redact`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PostRedactBlog202),
      orElse: unexpectedStatus
    }))
  ),
    "updatePageTitle": (id, options) => HttpClientRequest.put(`/pages/${id}/title`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdatePageTitle200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageVersions": (id, options) => HttpClientRequest.get(`/pages/${id}/versions`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageVersions200),
      orElse: unexpectedStatus
    }))
  ),
    "createWhiteboard": (options) => HttpClientRequest.post(`/whiteboards`).pipe(
    HttpClientRequest.setUrlParams({ "private": options.params?.["private"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateWhiteboard200),
      orElse: unexpectedStatus
    }))
  ),
    "getWhiteboardById": (id, options) => HttpClientRequest.get(`/whiteboards/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "include-collaborators": options?.params?.["include-collaborators"] as any, "include-direct-children": options?.params?.["include-direct-children"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-properties": options?.params?.["include-properties"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWhiteboardById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteWhiteboard": (id, options) => HttpClientRequest.delete(`/whiteboards/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getWhiteboardContentProperties": (id, options) => HttpClientRequest.get(`/whiteboards/${id}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWhiteboardContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createWhiteboardProperty": (id, options) => HttpClientRequest.post(`/whiteboards/${id}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateWhiteboardProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getWhiteboardContentPropertiesById": (whiteboardId, propertyId, options) => HttpClientRequest.get(`/whiteboards/${whiteboardId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWhiteboardContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateWhiteboardPropertyById": (whiteboardId, propertyId, options) => HttpClientRequest.put(`/whiteboards/${whiteboardId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateWhiteboardPropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteWhiteboardPropertyById": (whiteboardId, propertyId, options) => HttpClientRequest.delete(`/whiteboards/${whiteboardId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getWhiteboardOperations": (id, options) => HttpClientRequest.get(`/whiteboards/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWhiteboardOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getWhiteboardDirectChildren": (id, options) => HttpClientRequest.get(`/whiteboards/${id}/direct-children`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWhiteboardDirectChildren200),
      orElse: unexpectedStatus
    }))
  ),
    "getWhiteboardDescendants": (id, options) => HttpClientRequest.get(`/whiteboards/${id}/descendants`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any, "depth": options?.params?.["depth"] as any, "cursor": options?.params?.["cursor"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWhiteboardDescendants200),
      orElse: unexpectedStatus
    }))
  ),
    "getWhiteboardAncestors": (id, options) => HttpClientRequest.get(`/whiteboards/${id}/ancestors`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWhiteboardAncestors200),
      orElse: unexpectedStatus
    }))
  ),
    "createDatabase": (options) => HttpClientRequest.post(`/databases`).pipe(
    HttpClientRequest.setUrlParams({ "private": options.params?.["private"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateDatabase200),
      orElse: unexpectedStatus
    }))
  ),
    "getDatabaseById": (id, options) => HttpClientRequest.get(`/databases/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "include-collaborators": options?.params?.["include-collaborators"] as any, "include-direct-children": options?.params?.["include-direct-children"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-properties": options?.params?.["include-properties"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDatabaseById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteDatabase": (id, options) => HttpClientRequest.delete(`/databases/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getDatabaseContentProperties": (id, options) => HttpClientRequest.get(`/databases/${id}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDatabaseContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createDatabaseProperty": (id, options) => HttpClientRequest.post(`/databases/${id}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateDatabaseProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getDatabaseContentPropertiesById": (databaseId, propertyId, options) => HttpClientRequest.get(`/databases/${databaseId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDatabaseContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateDatabasePropertyById": (databaseId, propertyId, options) => HttpClientRequest.put(`/databases/${databaseId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateDatabasePropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteDatabasePropertyById": (databaseId, propertyId, options) => HttpClientRequest.delete(`/databases/${databaseId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getDatabaseOperations": (id, options) => HttpClientRequest.get(`/databases/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDatabaseOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getDatabaseDirectChildren": (id, options) => HttpClientRequest.get(`/databases/${id}/direct-children`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDatabaseDirectChildren200),
      orElse: unexpectedStatus
    }))
  ),
    "getDatabaseDescendants": (id, options) => HttpClientRequest.get(`/databases/${id}/descendants`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any, "depth": options?.params?.["depth"] as any, "cursor": options?.params?.["cursor"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDatabaseDescendants200),
      orElse: unexpectedStatus
    }))
  ),
    "getDatabaseAncestors": (id, options) => HttpClientRequest.get(`/databases/${id}/ancestors`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDatabaseAncestors200),
      orElse: unexpectedStatus
    }))
  ),
    "createSmartLink": (options) => HttpClientRequest.post(`/embeds`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateSmartLink200),
      orElse: unexpectedStatus
    }))
  ),
    "getSmartLinkById": (id, options) => HttpClientRequest.get(`/embeds/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "include-collaborators": options?.params?.["include-collaborators"] as any, "include-direct-children": options?.params?.["include-direct-children"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-properties": options?.params?.["include-properties"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSmartLinkById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteSmartLink": (id, options) => HttpClientRequest.delete(`/embeds/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getSmartLinkContentProperties": (id, options) => HttpClientRequest.get(`/embeds/${id}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSmartLinkContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createSmartLinkProperty": (id, options) => HttpClientRequest.post(`/embeds/${id}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateSmartLinkProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getSmartLinkContentPropertiesById": (embedId, propertyId, options) => HttpClientRequest.get(`/embeds/${embedId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSmartLinkContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateSmartLinkPropertyById": (embedId, propertyId, options) => HttpClientRequest.put(`/embeds/${embedId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateSmartLinkPropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteSmartLinkPropertyById": (embedId, propertyId, options) => HttpClientRequest.delete(`/embeds/${embedId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getSmartLinkOperations": (id, options) => HttpClientRequest.get(`/embeds/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSmartLinkOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getSmartLinkDirectChildren": (id, options) => HttpClientRequest.get(`/embeds/${id}/direct-children`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSmartLinkDirectChildren200),
      orElse: unexpectedStatus
    }))
  ),
    "getSmartLinkDescendants": (id, options) => HttpClientRequest.get(`/embeds/${id}/descendants`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any, "depth": options?.params?.["depth"] as any, "cursor": options?.params?.["cursor"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSmartLinkDescendants200),
      orElse: unexpectedStatus
    }))
  ),
    "getSmartLinkAncestors": (id, options) => HttpClientRequest.get(`/embeds/${id}/ancestors`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSmartLinkAncestors200),
      orElse: unexpectedStatus
    }))
  ),
    "createFolder": (options) => HttpClientRequest.post(`/folders`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateFolder200),
      orElse: unexpectedStatus
    }))
  ),
    "getFolderById": (id, options) => HttpClientRequest.get(`/folders/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "include-collaborators": options?.params?.["include-collaborators"] as any, "include-direct-children": options?.params?.["include-direct-children"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-properties": options?.params?.["include-properties"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFolderById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteFolder": (id, options) => HttpClientRequest.delete(`/folders/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getFolderContentProperties": (id, options) => HttpClientRequest.get(`/folders/${id}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFolderContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createFolderProperty": (id, options) => HttpClientRequest.post(`/folders/${id}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateFolderProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getFolderContentPropertiesById": (folderId, propertyId, options) => HttpClientRequest.get(`/folders/${folderId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFolderContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateFolderPropertyById": (folderId, propertyId, options) => HttpClientRequest.put(`/folders/${folderId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateFolderPropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteFolderPropertyById": (folderId, propertyId, options) => HttpClientRequest.delete(`/folders/${folderId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getFolderOperations": (id, options) => HttpClientRequest.get(`/folders/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFolderOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getFolderDirectChildren": (id, options) => HttpClientRequest.get(`/folders/${id}/direct-children`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFolderDirectChildren200),
      orElse: unexpectedStatus
    }))
  ),
    "getFolderDescendants": (id, options) => HttpClientRequest.get(`/folders/${id}/descendants`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any, "depth": options?.params?.["depth"] as any, "cursor": options?.params?.["cursor"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFolderDescendants200),
      orElse: unexpectedStatus
    }))
  ),
    "getFolderAncestors": (id, options) => HttpClientRequest.get(`/folders/${id}/ancestors`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFolderAncestors200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageVersionDetails": (pageId, versionNumber, options) => HttpClientRequest.get(`/pages/${pageId}/versions/${versionNumber}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageVersionDetails200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentVersions": (customContentId, options) => HttpClientRequest.get(`/custom-content/${customContentId}/versions`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentVersions200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentVersionDetails": (customContentId, versionNumber, options) => HttpClientRequest.get(`/custom-content/${customContentId}/versions/${versionNumber}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentVersionDetails200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaces": (options) => HttpClientRequest.get(`/spaces`).pipe(
    HttpClientRequest.setUrlParams({ "ids": options?.params?.["ids"] as any, "keys": options?.params?.["keys"] as any, "type": options?.params?.["type"] as any, "status": options?.params?.["status"] as any, "labels": options?.params?.["labels"] as any, "favorited-by": options?.params?.["favorited-by"] as any, "not-favorited-by": options?.params?.["not-favorited-by"] as any, "sort": options?.params?.["sort"] as any, "description-format": options?.params?.["description-format"] as any, "include-icon": options?.params?.["include-icon"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaces200),
      orElse: unexpectedStatus
    }))
  ),
    "createSpace": (options) => HttpClientRequest.post(`/spaces`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateSpace201),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceById": (id, options) => HttpClientRequest.get(`/spaces/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "description-format": options?.params?.["description-format"] as any, "include-icon": options?.params?.["include-icon"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-properties": options?.params?.["include-properties"] as any, "include-permissions": options?.params?.["include-permissions"] as any, "include-role-assignments": options?.params?.["include-role-assignments"] as any, "include-labels": options?.params?.["include-labels"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceById200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostsInSpace": (id, options) => HttpClientRequest.get(`/spaces/${id}/blogposts`).pipe(
    HttpClientRequest.setUrlParams({ "sort": options?.params?.["sort"] as any, "status": options?.params?.["status"] as any, "title": options?.params?.["title"] as any, "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostsInSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceLabels": (id, options) => HttpClientRequest.get(`/spaces/${id}/labels`).pipe(
    HttpClientRequest.setUrlParams({ "prefix": options?.params?.["prefix"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceLabels200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceContentLabels": (id, options) => HttpClientRequest.get(`/spaces/${id}/content/labels`).pipe(
    HttpClientRequest.setUrlParams({ "prefix": options?.params?.["prefix"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceContentLabels200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentByTypeInSpace": (id, options) => HttpClientRequest.get(`/spaces/${id}/custom-content`).pipe(
    HttpClientRequest.setUrlParams({ "type": options.params["type"] as any, "cursor": options.params["cursor"] as any, "limit": options.params["limit"] as any, "body-format": options.params["body-format"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentByTypeInSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceOperations": (id, options) => HttpClientRequest.get(`/spaces/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getPagesInSpace": (id, options) => HttpClientRequest.get(`/spaces/${id}/pages`).pipe(
    HttpClientRequest.setUrlParams({ "depth": options?.params?.["depth"] as any, "sort": options?.params?.["sort"] as any, "status": options?.params?.["status"] as any, "title": options?.params?.["title"] as any, "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPagesInSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceProperties": (spaceId, options) => HttpClientRequest.get(`/spaces/${spaceId}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createSpaceProperty": (spaceId, options) => HttpClientRequest.post(`/spaces/${spaceId}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateSpaceProperty201),
      orElse: unexpectedStatus
    }))
  ),
    "getSpacePropertyById": (spaceId, propertyId, options) => HttpClientRequest.get(`/spaces/${spaceId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpacePropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateSpacePropertyById": (spaceId, propertyId, options) => HttpClientRequest.put(`/spaces/${spaceId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateSpacePropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteSpacePropertyById": (spaceId, propertyId, options) => HttpClientRequest.delete(`/spaces/${spaceId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getSpacePermissionsAssignments": (id, options) => HttpClientRequest.get(`/spaces/${id}/permissions`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpacePermissionsAssignments200),
      orElse: unexpectedStatus
    }))
  ),
    "getAvailableSpacePermissions": (options) => HttpClientRequest.get(`/space-permissions`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAvailableSpacePermissions200),
      orElse: unexpectedStatus
    }))
  ),
    "listSpacePermissionCombinations": (options) => HttpClientRequest.get(`/space-permissions/transition/combinations`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(ListSpacePermissionCombinations200),
      orElse: unexpectedStatus
    }))
  ),
    "generateSpacePermissionCombinations": (options) => HttpClientRequest.post(`/space-permissions/transition/combinations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GenerateSpacePermissionCombinations202),
      orElse: unexpectedStatus
    }))
  ),
    "bulkAssignSpacePermissionRoles": (options) => HttpClientRequest.post(`/space-permissions/transition/role-assignments`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(BulkAssignSpacePermissionRoles202),
      orElse: unexpectedStatus
    }))
  ),
    "bulkRemoveSpacePermissionAccess": (options) => HttpClientRequest.post(`/space-permissions/transition/access-removals`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(BulkRemoveSpacePermissionAccess202),
      orElse: unexpectedStatus
    }))
  ),
    "getSpacePermissionTransitionTaskStatus": (taskId, options) => HttpClientRequest.get(`/space-permissions/transition/tasks/${taskId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpacePermissionTransitionTaskStatus200),
      orElse: unexpectedStatus
    }))
  ),
    "getAvailableSpaceRoles": (options) => HttpClientRequest.get(`/space-roles`).pipe(
    HttpClientRequest.setUrlParams({ "space-id": options?.params?.["space-id"] as any, "role-type": options?.params?.["role-type"] as any, "principal-id": options?.params?.["principal-id"] as any, "principal-type": options?.params?.["principal-type"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAvailableSpaceRoles200),
      orElse: unexpectedStatus
    }))
  ),
    "createSpaceRole": (options) => HttpClientRequest.post(`/space-roles`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateSpaceRole201),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceRolesById": (id, options) => HttpClientRequest.get(`/space-roles/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceRolesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateSpaceRole": (id, options) => HttpClientRequest.put(`/space-roles/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateSpaceRole202),
      orElse: unexpectedStatus
    }))
  ),
    "deleteSpaceRole": (id, options) => HttpClientRequest.delete(`/space-roles/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteSpaceRole202),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceRoleMode": (options) => HttpClientRequest.get(`/space-role-mode`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceRoleMode200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceRoleAssignments": (id, options) => HttpClientRequest.get(`/spaces/${id}/role-assignments`).pipe(
    HttpClientRequest.setUrlParams({ "role-id": options?.params?.["role-id"] as any, "role-type": options?.params?.["role-type"] as any, "principal-id": options?.params?.["principal-id"] as any, "principal-type": options?.params?.["principal-type"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceRoleAssignments200),
      orElse: unexpectedStatus
    }))
  ),
    "setSpaceRoleAssignments": (id, options) => HttpClientRequest.post(`/spaces/${id}/role-assignments`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetSpaceRoleAssignments200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageFooterComments": (id, options) => HttpClientRequest.get(`/pages/${id}/footer-comments`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "status": options?.params?.["status"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageFooterComments200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageInlineComments": (id, options) => HttpClientRequest.get(`/pages/${id}/inline-comments`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "status": options?.params?.["status"] as any, "resolution-status": options?.params?.["resolution-status"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageInlineComments200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostFooterComments": (id, options) => HttpClientRequest.get(`/blogposts/${id}/footer-comments`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "status": options?.params?.["status"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostFooterComments200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostInlineComments": (id, options) => HttpClientRequest.get(`/blogposts/${id}/inline-comments`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "status": options?.params?.["status"] as any, "resolution-status": options?.params?.["resolution-status"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostInlineComments200),
      orElse: unexpectedStatus
    }))
  ),
    "getFooterComments": (options) => HttpClientRequest.get(`/footer-comments`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFooterComments200),
      orElse: unexpectedStatus
    }))
  ),
    "createFooterComment": (options) => HttpClientRequest.post(`/footer-comments`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateFooterComment201),
      orElse: unexpectedStatus
    }))
  ),
    "getFooterCommentById": (commentId, options) => HttpClientRequest.get(`/footer-comments/${commentId}`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "version": options?.params?.["version"] as any, "include-properties": options?.params?.["include-properties"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-likes": options?.params?.["include-likes"] as any, "include-versions": options?.params?.["include-versions"] as any, "include-version": options?.params?.["include-version"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFooterCommentById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateFooterComment": (commentId, options) => HttpClientRequest.put(`/footer-comments/${commentId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateFooterComment200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteFooterComment": (commentId, options) => HttpClientRequest.delete(`/footer-comments/${commentId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getFooterCommentChildren": (id, options) => HttpClientRequest.get(`/footer-comments/${id}/children`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFooterCommentChildren200),
      orElse: unexpectedStatus
    }))
  ),
    "getFooterLikeCount": (id, options) => HttpClientRequest.get(`/footer-comments/${id}/likes/count`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFooterLikeCount200),
      orElse: unexpectedStatus
    }))
  ),
    "getFooterLikeUsers": (id, options) => HttpClientRequest.get(`/footer-comments/${id}/likes/users`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFooterLikeUsers200),
      orElse: unexpectedStatus
    }))
  ),
    "getFooterCommentOperations": (id, options) => HttpClientRequest.get(`/footer-comments/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFooterCommentOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getFooterCommentVersions": (id, options) => HttpClientRequest.get(`/footer-comments/${id}/versions`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFooterCommentVersions200),
      orElse: unexpectedStatus
    }))
  ),
    "getFooterCommentVersionDetails": (id, versionNumber, options) => HttpClientRequest.get(`/footer-comments/${id}/versions/${versionNumber}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFooterCommentVersionDetails200),
      orElse: unexpectedStatus
    }))
  ),
    "getInlineComments": (options) => HttpClientRequest.get(`/inline-comments`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInlineComments200),
      orElse: unexpectedStatus
    }))
  ),
    "createInlineComment": (options) => HttpClientRequest.post(`/inline-comments`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateInlineComment201),
      orElse: unexpectedStatus
    }))
  ),
    "getInlineCommentById": (commentId, options) => HttpClientRequest.get(`/inline-comments/${commentId}`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "version": options?.params?.["version"] as any, "include-properties": options?.params?.["include-properties"] as any, "include-operations": options?.params?.["include-operations"] as any, "include-likes": options?.params?.["include-likes"] as any, "include-versions": options?.params?.["include-versions"] as any, "include-version": options?.params?.["include-version"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInlineCommentById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateInlineComment": (commentId, options) => HttpClientRequest.put(`/inline-comments/${commentId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateInlineComment200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteInlineComment": (commentId, options) => HttpClientRequest.delete(`/inline-comments/${commentId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getInlineCommentChildren": (id, options) => HttpClientRequest.get(`/inline-comments/${id}/children`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInlineCommentChildren200),
      orElse: unexpectedStatus
    }))
  ),
    "getInlineLikeCount": (id, options) => HttpClientRequest.get(`/inline-comments/${id}/likes/count`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInlineLikeCount200),
      orElse: unexpectedStatus
    }))
  ),
    "getInlineLikeUsers": (id, options) => HttpClientRequest.get(`/inline-comments/${id}/likes/users`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInlineLikeUsers200),
      orElse: unexpectedStatus
    }))
  ),
    "getInlineCommentOperations": (id, options) => HttpClientRequest.get(`/inline-comments/${id}/operations`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInlineCommentOperations200),
      orElse: unexpectedStatus
    }))
  ),
    "getInlineCommentVersions": (id, options) => HttpClientRequest.get(`/inline-comments/${id}/versions`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInlineCommentVersions200),
      orElse: unexpectedStatus
    }))
  ),
    "getInlineCommentVersionDetails": (id, versionNumber, options) => HttpClientRequest.get(`/inline-comments/${id}/versions/${versionNumber}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInlineCommentVersionDetails200),
      orElse: unexpectedStatus
    }))
  ),
    "getCommentContentProperties": (commentId, options) => HttpClientRequest.get(`/comments/${commentId}/properties`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCommentContentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "createCommentProperty": (commentId, options) => HttpClientRequest.post(`/comments/${commentId}/properties`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateCommentProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "getCommentContentPropertiesById": (commentId, propertyId, options) => HttpClientRequest.get(`/comments/${commentId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCommentContentPropertiesById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateCommentPropertyById": (commentId, propertyId, options) => HttpClientRequest.put(`/comments/${commentId}/properties/${propertyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateCommentPropertyById200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteCommentPropertyById": (commentId, propertyId, options) => HttpClientRequest.delete(`/comments/${commentId}/properties/${propertyId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getTasks": (options) => HttpClientRequest.get(`/tasks`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any, "include-blank-tasks": options?.params?.["include-blank-tasks"] as any, "status": options?.params?.["status"] as any, "task-id": options?.params?.["task-id"] as any, "space-id": options?.params?.["space-id"] as any, "page-id": options?.params?.["page-id"] as any, "blogpost-id": options?.params?.["blogpost-id"] as any, "created-by": options?.params?.["created-by"] as any, "assigned-to": options?.params?.["assigned-to"] as any, "completed-by": options?.params?.["completed-by"] as any, "created-at-from": options?.params?.["created-at-from"] as any, "created-at-to": options?.params?.["created-at-to"] as any, "due-at-from": options?.params?.["due-at-from"] as any, "due-at-to": options?.params?.["due-at-to"] as any, "completed-at-from": options?.params?.["completed-at-from"] as any, "completed-at-to": options?.params?.["completed-at-to"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTasks200),
      orElse: unexpectedStatus
    }))
  ),
    "getTaskById": (id, options) => HttpClientRequest.get(`/tasks/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options?.params?.["body-format"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTaskById200),
      orElse: unexpectedStatus
    }))
  ),
    "updateTask": (id, options) => HttpClientRequest.put(`/tasks/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "body-format": options.params?.["body-format"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateTask200),
      orElse: unexpectedStatus
    }))
  ),
    "getChildPages": (id, options) => HttpClientRequest.get(`/pages/${id}/children`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetChildPages200),
      orElse: unexpectedStatus
    }))
  ),
    "getChildCustomContent": (id, options) => HttpClientRequest.get(`/custom-content/${id}/children`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetChildCustomContent200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageDirectChildren": (id, options) => HttpClientRequest.get(`/pages/${id}/direct-children`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "sort": options?.params?.["sort"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageDirectChildren200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageAncestors": (id, options) => HttpClientRequest.get(`/pages/${id}/ancestors`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageAncestors200),
      orElse: unexpectedStatus
    }))
  ),
    "getPageDescendants": (id, options) => HttpClientRequest.get(`/pages/${id}/descendants`).pipe(
    HttpClientRequest.setUrlParams({ "limit": options?.params?.["limit"] as any, "depth": options?.params?.["depth"] as any, "cursor": options?.params?.["cursor"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageDescendants200),
      orElse: unexpectedStatus
    }))
  ),
    "createBulkUserLookup": (options) => HttpClientRequest.post(`/users-bulk`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateBulkUserLookup200),
      orElse: unexpectedStatus
    }))
  ),
    "checkAccessByEmail": (options) => HttpClientRequest.post(`/user/access/check-access-by-email`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CheckAccessByEmail200),
      orElse: unexpectedStatus
    }))
  ),
    "inviteByEmail": (options) => HttpClientRequest.post(`/user/access/invite-by-email`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getDataPolicyMetadata": (options) => HttpClientRequest.get(`/data-policies/metadata`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDataPolicyMetadata200),
      orElse: unexpectedStatus
    }))
  ),
    "getDataPolicySpaces": (options) => HttpClientRequest.get(`/data-policies/spaces`).pipe(
    HttpClientRequest.setUrlParams({ "ids": options?.params?.["ids"] as any, "keys": options?.params?.["keys"] as any, "sort": options?.params?.["sort"] as any, "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDataPolicySpaces200),
      orElse: unexpectedStatus
    }))
  ),
    "getClassificationLevels": (options) => HttpClientRequest.get(`/classification-levels`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetClassificationLevels200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceDefaultClassificationLevel": (id, options) => HttpClientRequest.get(`/spaces/${id}/classification-level/default`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceDefaultClassificationLevel200),
      orElse: unexpectedStatus
    }))
  ),
    "putSpaceDefaultClassificationLevel": (id, options) => HttpClientRequest.put(`/spaces/${id}/classification-level/default`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "deleteSpaceDefaultClassificationLevel": (id, options) => HttpClientRequest.delete(`/spaces/${id}/classification-level/default`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getPageClassificationLevel": (id, options) => HttpClientRequest.get(`/pages/${id}/classification-level`).pipe(
    HttpClientRequest.setUrlParams({ "status": options?.params?.["status"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPageClassificationLevel200),
      orElse: unexpectedStatus
    }))
  ),
    "putPageClassificationLevel": (id, options) => HttpClientRequest.put(`/pages/${id}/classification-level`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "postPageClassificationLevel": (id, options) => HttpClientRequest.post(`/pages/${id}/classification-level/reset`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getBlogPostClassificationLevel": (id, options) => HttpClientRequest.get(`/blogposts/${id}/classification-level`).pipe(
    HttpClientRequest.setUrlParams({ "status": options?.params?.["status"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlogPostClassificationLevel200),
      orElse: unexpectedStatus
    }))
  ),
    "putBlogPostClassificationLevel": (id, options) => HttpClientRequest.put(`/blogposts/${id}/classification-level`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "postBlogPostClassificationLevel": (id, options) => HttpClientRequest.post(`/blogposts/${id}/classification-level/reset`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getWhiteboardClassificationLevel": (id, options) => HttpClientRequest.get(`/whiteboards/${id}/classification-level`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWhiteboardClassificationLevel200),
      orElse: unexpectedStatus
    }))
  ),
    "putWhiteboardClassificationLevel": (id, options) => HttpClientRequest.put(`/whiteboards/${id}/classification-level`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "postWhiteboardClassificationLevel": (id, options) => HttpClientRequest.post(`/whiteboards/${id}/classification-level/reset`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getDatabaseClassificationLevel": (id, options) => HttpClientRequest.get(`/databases/${id}/classification-level`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDatabaseClassificationLevel200),
      orElse: unexpectedStatus
    }))
  ),
    "putDatabaseClassificationLevel": (id, options) => HttpClientRequest.put(`/databases/${id}/classification-level`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "postDatabaseClassificationLevel": (id, options) => HttpClientRequest.post(`/databases/${id}/classification-level/reset`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getAttachmentThumbnailById": (id, options) => HttpClientRequest.get(`/attachments/${id}/thumbnail/download`).pipe(
    HttpClientRequest.setUrlParams({ "version": options?.params?.["version"] as any, "height": options?.params?.["height"] as any, "width": options?.params?.["width"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "302": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getForgeAppProperties": (options) => HttpClientRequest.get(`/app/properties`).pipe(
    HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetForgeAppProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "getForgeAppProperty": (propertyKey, options) => HttpClientRequest.get(`/app/properties/${propertyKey}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetForgeAppProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "putForgeAppProperty": (propertyKey, options) => HttpClientRequest.put(`/app/properties/${propertyKey}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      "201": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "deleteForgeAppProperty": (propertyKey, options) => HttpClientRequest.delete(`/app/properties/${propertyKey}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  )
  }
}

export interface ConfluenceV2Api {
  readonly httpClient: HttpClient.HttpClient
  /**
* Returns information about the admin key if one is currently enabled for the calling user within the site.
*
* **[Permissions](https://support.atlassian.com/user-management/docs/give-users-admin-permissions/#Centralized-user-management-content) required**:
* User must be an organization or site admin.
*/
readonly "getAdminKey": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAdminKey200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Enables admin key access for the calling user within the site. If an admin key already exists for the user, a new one will be issued with an updated expiration time.
*
* **Note:** The `durationInMinutes` field within the request body is optional. If the request body is empty or if the `durationInMinutes` is set to 0 minutes, a new admin key will be issued to the calling user with a default duration of 10 minutes.
*
* **[Permissions](https://support.atlassian.com/user-management/docs/give-users-admin-permissions/#Centralized-user-management-content) required**:
* User must be an organization or site admin.
*/
readonly "enableAdminKey": <Config extends OperationConfig>(options: { readonly payload: typeof EnableAdminKeyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof EnableAdminKey200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Disables admin key access for the calling user within the site.
*
* **[Permissions](https://support.atlassian.com/user-management/docs/give-users-admin-permissions/#Centralized-user-management-content) required**:
* User must be an organization or site admin.
*/
readonly "disableAdminKey": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all attachments. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the container of the attachment.
*/
readonly "getAttachments": <Config extends OperationConfig>(options: { readonly params?: typeof GetAttachmentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific attachment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the attachment's container.
*/
readonly "getAttachmentById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetAttachmentByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachmentById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete an attachment by id.
*
* Deleting an attachment moves the attachment to the trash, where it can be restored later. To permanently delete an attachment (or "purge" it),
* the endpoint must be called on a **trashed** attachment with the following param `purge=true`.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the container of the attachment.
* Permission to delete attachments in the space.
* Permission to administer the space (if attempting to purge).
*/
readonly "deleteAttachment": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof DeleteAttachmentParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the labels of specific attachment. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the parent content of the attachment and its corresponding space.
* Only labels that the user has permission to view will be returned.
*/
readonly "getAttachmentLabels": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetAttachmentLabelsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachmentLabels200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific attachment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the parent content of the attachment and its corresponding space.
*/
readonly "getAttachmentOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachmentOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves all Content Properties tied to a specified attachment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the attachment.
*/
readonly "getAttachmentContentProperties": <Config extends OperationConfig>(attachmentId: string, options: { readonly params?: typeof GetAttachmentContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachmentContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content property for an attachment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the attachment.
*/
readonly "createAttachmentProperty": <Config extends OperationConfig>(attachmentId: string, options: { readonly payload: typeof CreateAttachmentPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateAttachmentProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified attachment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the attachment.
*/
readonly "getAttachmentContentPropertiesById": <Config extends OperationConfig>(attachmentId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachmentContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for attachment by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the attachment.
*/
readonly "updateAttachmentPropertyById": <Config extends OperationConfig>(attachmentId: string, propertyId: string, options: { readonly payload: typeof UpdateAttachmentPropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateAttachmentPropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for an attachment by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to attachment the page.
*/
readonly "deleteAttachmentPropertyById": <Config extends OperationConfig>(attachmentId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the versions of specific attachment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the attachment and its corresponding space.
*/
readonly "getAttachmentVersions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetAttachmentVersionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachmentVersions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves version details for the specified attachment and version number.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the attachment.
*/
readonly "getAttachmentVersionDetails": <Config extends OperationConfig>(attachmentId: string, versionNumber: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachmentVersionDetails200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the comments of the specific attachment.
* The number of results is limited by the `limit` parameter and additional results (if available) will be available through
* the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the attachment and its corresponding containers.
*/
readonly "getAttachmentComments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetAttachmentCommentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAttachmentComments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all blog posts. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only blog posts that the user has permission to view will be returned.
*/
readonly "getBlogPosts": <Config extends OperationConfig>(options: { readonly params?: typeof GetBlogPostsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPosts200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new blog post in the space specified by the spaceId.
*
* By default this will create the blog post as a non-draft, unless the status is specified as draft.
* If creating a non-draft, the title must not be empty.
*
* Currently only supports the storage representation specified in the body.representation enums below
*/
readonly "createBlogPost": <Config extends OperationConfig>(options: { readonly params?: typeof CreateBlogPostParams.Encoded | undefined; readonly payload: typeof CreateBlogPostRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateBlogPost200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the blog post and its corresponding space.
*/
readonly "getBlogPostById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogPostByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a blog post by id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the blog post and its corresponding space. Permission to update blog posts in the space.
*/
readonly "updateBlogPost": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof UpdateBlogPostRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateBlogPost200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a blog post by id.
*
* By default this will delete blog posts that are non-drafts. To delete a blog post that is a draft, the endpoint must be called on a
* draft with the following param `draft=true`. Discarded drafts are not sent to the trash and are permanently deleted.
*
* Deleting a blog post that is not a draft moves the blog post to the trash, where it can be restored later.
* To permanently delete a blog post (or "purge" it), the endpoint must be called on a **trashed** blog post with the following param `purge=true`.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the blog post and its corresponding space.
* Permission to delete blog posts in the space.
* Permission to administer the space (if attempting to purge).
*/
readonly "deleteBlogPost": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof DeleteBlogPostParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the attachments of specific blog post. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the blog post and its corresponding space.
*/
readonly "getBlogpostAttachments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogpostAttachmentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogpostAttachments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all custom content for a given type within a given blogpost. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content, the container of the custom content (blog post), and the corresponding space.
*/
readonly "getCustomContentByTypeInBlogPost": <Config extends OperationConfig>(id: string, options: { readonly params: typeof GetCustomContentByTypeInBlogPostParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentByTypeInBlogPost200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the labels of specific blog post. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the blog post and its corresponding space.
* Only labels that the user has permission to view will be returned.
*/
readonly "getBlogPostLabels": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogPostLabelsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostLabels200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the count of likes of specific blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the blog post and its corresponding space.
*/
readonly "getBlogPostLikeCount": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostLikeCount200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the account IDs of likes of specific blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the blog post and its corresponding space.
*/
readonly "getBlogPostLikeUsers": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogPostLikeUsersParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostLikeUsers200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves all Content Properties tied to a specified blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the blog post.
*/
readonly "getBlogpostContentProperties": <Config extends OperationConfig>(blogpostId: string, options: { readonly params?: typeof GetBlogpostContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogpostContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new property for a blogpost.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the blog post.
*/
readonly "createBlogpostProperty": <Config extends OperationConfig>(blogpostId: string, options: { readonly payload: typeof CreateBlogpostPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateBlogpostProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the blog post.
*/
readonly "getBlogpostContentPropertiesById": <Config extends OperationConfig>(blogpostId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogpostContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for blog post by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the blog post.
*/
readonly "updateBlogpostPropertyById": <Config extends OperationConfig>(blogpostId: string, propertyId: string, options: { readonly payload: typeof UpdateBlogpostPropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateBlogpostPropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for a blogpost by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the blog post.
*/
readonly "deleteBlogpostPropertyById": <Config extends OperationConfig>(blogpostId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the parent content of the blog post and its corresponding space.
*/
readonly "getBlogPostOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the versions of specific blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the blog post and its corresponding space.
*/
readonly "getBlogPostVersions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogPostVersionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostVersions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves version details for the specified blog post and version number.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the blog post.
*/
readonly "getBlogPostVersionDetails": <Config extends OperationConfig>(blogpostId: string, versionNumber: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostVersionDetails200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Converts a list of content ids into their associated content types. This is useful for users migrating from v1 to v2
* who may have stored just content ids without their associated type. This will return types as they should be used in v2.
* Notably, this will return `inline-comment` for inline comments and `footer-comment` for footer comments, which is distinct from them
* both being represented by `comment` in v1.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the requested content. Any content that the user does not have permission to view or does not exist will map to `null` in the response.
*/
readonly "convertContentIdsToContentTypes": <Config extends OperationConfig>(options: { readonly payload: typeof ConvertContentIdsToContentTypesRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof ConvertContentIdsToContentTypes200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all custom content for a given type. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content, the container of the custom content, and the corresponding space (if different from the container).
*/
readonly "getCustomContentByType": <Config extends OperationConfig>(options: { readonly params: typeof GetCustomContentByTypeParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentByType200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new custom content in the given space, page, blogpost or other custom content.
*
* Only one of `spaceId`, `pageId`, `blogPostId`, or `customContentId` is required in the request body.
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space. Permission to create custom content in the space.
*/
readonly "createCustomContent": <Config extends OperationConfig>(options: { readonly payload: typeof CreateCustomContentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateCustomContent201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific piece of custom content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content, the container of the custom content, and the corresponding space (if different from the container).
*/
readonly "getCustomContentById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetCustomContentByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a custom content by id.
* At most one of `spaceId`, `pageId`, `blogPostId`, or `customContentId` is allowed in the request body.
* Note that if `spaceId` is specified, it must be the same as the `spaceId` used for creating the custom content
* as moving custom content to a different space is not supported.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space. Permission to update custom content in the space.
*/
readonly "updateCustomContent": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof UpdateCustomContentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateCustomContent200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a custom content by id.
*
* Deleting a custom content will either move it to the trash or permanently delete it (purge it), depending on the apiSupport.
* To permanently delete a **trashed** custom content, the endpoint must be called with the following param `purge=true`.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space.
* Permission to delete custom content in the space.
* Permission to administer the space (if attempting to purge).
*/
readonly "deleteCustomContent": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof DeleteCustomContentParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the attachments of specific custom content. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the custom content and its corresponding space.
*/
readonly "getCustomContentAttachments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetCustomContentAttachmentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentAttachments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the comments of the specific custom content.
* The number of results is limited by the `limit` parameter and additional results (if available) will be available through
* the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content and its corresponding containers.
*/
readonly "getCustomContentComments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetCustomContentCommentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentComments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the labels for a specific piece of custom content. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content and its corresponding space.
* Only labels that the user has permission to view will be returned.
*/
readonly "getCustomContentLabels": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetCustomContentLabelsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentLabels200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific custom content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the parent content of the custom content and its corresponding space.
*/
readonly "getCustomContentOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves Content Properties tied to a specified custom content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content.
*/
readonly "getCustomContentContentProperties": <Config extends OperationConfig>(customContentId: string, options: { readonly params?: typeof GetCustomContentContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content property for a piece of custom content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the custom content.
*/
readonly "createCustomContentProperty": <Config extends OperationConfig>(customContentId: string, options: { readonly payload: typeof CreateCustomContentPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateCustomContentProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified custom content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page.
*/
readonly "getCustomContentContentPropertiesById": <Config extends OperationConfig>(customContentId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for a piece of custom content by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the custom content.
*/
readonly "updateCustomContentPropertyById": <Config extends OperationConfig>(customContentId: string, propertyId: string, options: { readonly payload: typeof UpdateCustomContentPropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateCustomContentPropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for a piece of custom content by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the custom content.
*/
readonly "deleteCustomContentPropertyById": <Config extends OperationConfig>(customContentId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all labels. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only labels that the user has permission to view will be returned.
*/
readonly "getLabels": <Config extends OperationConfig>(options: { readonly params?: typeof GetLabelsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetLabels200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the attachments of specified label. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the attachment and its corresponding space.
*/
readonly "getLabelAttachments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetLabelAttachmentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetLabelAttachments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the blogposts of specified label. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getLabelBlogPosts": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetLabelBlogPostsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetLabelBlogPosts200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the pages of specified label. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getLabelPages": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetLabelPagesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetLabelPages200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all pages. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only pages that the user has permission to view will be returned.
*/
readonly "getPages": <Config extends OperationConfig>(options: { readonly params?: typeof GetPagesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPages200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a page in the space.
*
* Pages are created as published by default unless specified as a draft in the status field. If creating a published page, the title must be specified.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the corresponding space. Permission to create a page in the space.
*/
readonly "createPage": <Config extends OperationConfig>(options: { readonly params?: typeof CreatePageParams.Encoded | undefined; readonly payload: typeof CreatePageRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreatePage200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page and its corresponding space.
*/
readonly "getPageById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a page by id.
*
* When the "current" version is updated, the provided body content is considered as the latest version. This latest body content
* will be attempted to be merged into the draft version through a content reconciliation algorithm. If two versions are significantly diverged,
* the latest provided content may entirely override what was previously in the draft.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page and its corresponding space. Permission to update pages in the space.
*/
readonly "updatePage": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof UpdatePageRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdatePage200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a page by id.
*
* By default this will delete pages that are non-drafts. To delete a page that is a draft, the endpoint must be called on a
* draft with the following param `draft=true`. Discarded drafts are not sent to the trash and are permanently deleted.
*
* Deleting a page moves the page to the trash, where it can be restored later. To permanently delete a page (or "purge" it),
* the endpoint must be called on a **trashed** page with the following param `purge=true`.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page and its corresponding space.
* Permission to delete pages in the space.
* Permission to administer the space (if attempting to purge).
*/
readonly "deletePage": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof DeletePageParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the attachments of specific page. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getPageAttachments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageAttachmentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageAttachments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all custom content for a given type within a given page. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content, the container of the custom content (page), and the corresponding space.
*/
readonly "getCustomContentByTypeInPage": <Config extends OperationConfig>(id: string, options: { readonly params: typeof GetCustomContentByTypeInPageParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentByTypeInPage200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the labels of specific page. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
* Only labels that the user has permission to view will be returned.
*/
readonly "getPageLabels": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageLabelsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageLabels200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the count of likes of specific page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getPageLikeCount": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageLikeCount200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the account IDs of likes of specific page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getPageLikeUsers": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageLikeUsersParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageLikeUsers200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the parent content of the page and its corresponding space.
*/
readonly "getPageOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves Content Properties tied to a specified page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page.
*/
readonly "getPageContentProperties": <Config extends OperationConfig>(pageId: string, options: { readonly params?: typeof GetPageContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content property for a page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the page.
*/
readonly "createPageProperty": <Config extends OperationConfig>(pageId: string, options: { readonly payload: typeof CreatePagePropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreatePageProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page.
*/
readonly "getPageContentPropertiesById": <Config extends OperationConfig>(pageId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for a page by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the page.
*/
readonly "updatePagePropertyById": <Config extends OperationConfig>(pageId: string, propertyId: string, options: { readonly payload: typeof UpdatePagePropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdatePagePropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for a page by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the page.
*/
readonly "deletePagePropertyById": <Config extends OperationConfig>(pageId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Redacts sensitive content in a Confluence page by replacing specified text ranges with redaction markers.
* Each redaction in the response includes a unique UUID for restoration (except code block redactions).
* The response metadata items maintain the same order as the input redaction pointers, and completely
* overlapping redactions are merged into a single redaction with one UUID.
*
* **Note**: This endpoint requires **Atlassian Guard Premium**.
*/
readonly "postRedactPage": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PostRedactPageRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PostRedactPage202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Redacts sensitive content in a Confluence blog post by replacing specified text ranges with redaction markers.
* Each redaction in the response includes a unique UUID for restoration (except code block redactions).
* The response metadata items maintain the same order as the input redaction pointers, and completely
* overlapping redactions are merged into a single redaction with one UUID.
*
* **Note**: This endpoint requires **Atlassian Guard Premium**.
*/
readonly "postRedactBlog": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PostRedactBlogRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PostRedactBlog202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the title of a specified page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page and its corresponding space. Permission to update pages in the space.
*/
readonly "updatePageTitle": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof UpdatePageTitleRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdatePageTitle200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the versions of specific page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page and its corresponding space.
*/
readonly "getPageVersions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageVersionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageVersions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a whiteboard in the space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the corresponding space. Permission to create a whiteboard in the space.
*/
readonly "createWhiteboard": <Config extends OperationConfig>(options: { readonly params?: typeof CreateWhiteboardParams.Encoded | undefined; readonly payload: typeof CreateWhiteboardRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateWhiteboard200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific whiteboard.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the whiteboard and its corresponding space.
*/
readonly "getWhiteboardById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetWhiteboardByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWhiteboardById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a whiteboard by id.
*
* Deleting a whiteboard moves the whiteboard to the trash, where it can be restored later
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the whiteboard and its corresponding space.
* Permission to delete whiteboards in the space.
*/
readonly "deleteWhiteboard": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves Content Properties tied to a specified whiteboard.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the whiteboard.
*/
readonly "getWhiteboardContentProperties": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetWhiteboardContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWhiteboardContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content property for a whiteboard.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the whiteboard.
*/
readonly "createWhiteboardProperty": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof CreateWhiteboardPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateWhiteboardProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified whiteboard.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the whiteboard.
*/
readonly "getWhiteboardContentPropertiesById": <Config extends OperationConfig>(whiteboardId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWhiteboardContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for a whiteboard by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the whiteboard.
*/
readonly "updateWhiteboardPropertyById": <Config extends OperationConfig>(whiteboardId: string, propertyId: string, options: { readonly payload: typeof UpdateWhiteboardPropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateWhiteboardPropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for a whiteboard by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the whiteboard.
*/
readonly "deleteWhiteboardPropertyById": <Config extends OperationConfig>(whiteboardId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific whiteboard.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the whiteboard and its corresponding space.
*/
readonly "getWhiteboardOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWhiteboardOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all children for given whiteboard id in the content tree. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each child. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only content that the user has permission to view will be returned.
*/
readonly "getWhiteboardDirectChildren": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetWhiteboardDirectChildrenParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWhiteboardDirectChildren200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns descendants in the content tree for a given whiteboard by ID in top-to-bottom order (that is, the highest descendant is the first
* item in the response payload). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available by calling this endpoint with the cursor in the response payload. There is also a `depth` parameter specifying depth
* of descendants to be fetched.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each descendant. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the whiteboard and its corresponding space
*/
readonly "getWhiteboardDescendants": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetWhiteboardDescendantsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWhiteboardDescendants200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all ancestors for a given whiteboard by ID in top-to-bottom order (that is, the highest ancestor is the first
* item in the response payload). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available by calling this endpoint with the ID of first ancestor in the response payload.
*
* This endpoint returns minimal information about each ancestor. To fetch more details, use a related endpoint, such
* as [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the whiteboard and its corresponding space
*/
readonly "getWhiteboardAncestors": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetWhiteboardAncestorsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWhiteboardAncestors200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a database in the space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the corresponding space. Permission to create a database in the space.
*/
readonly "createDatabase": <Config extends OperationConfig>(options: { readonly params?: typeof CreateDatabaseParams.Encoded | undefined; readonly payload: typeof CreateDatabaseRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateDatabase200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific database.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the database and its corresponding space.
*/
readonly "getDatabaseById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetDatabaseByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDatabaseById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a database by id.
*
* Deleting a database moves the database to the trash, where it can be restored later
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the database and its corresponding space.
* Permission to delete databases in the space.
*/
readonly "deleteDatabase": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves Content Properties tied to a specified database.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the database.
*/
readonly "getDatabaseContentProperties": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetDatabaseContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDatabaseContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content property for a database.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the database.
*/
readonly "createDatabaseProperty": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof CreateDatabasePropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateDatabaseProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified database.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the database.
*/
readonly "getDatabaseContentPropertiesById": <Config extends OperationConfig>(databaseId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDatabaseContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for a database by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the database.
*/
readonly "updateDatabasePropertyById": <Config extends OperationConfig>(databaseId: string, propertyId: string, options: { readonly payload: typeof UpdateDatabasePropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateDatabasePropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for a database by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the database.
*/
readonly "deleteDatabasePropertyById": <Config extends OperationConfig>(databaseId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific database.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the database and its corresponding space.
*/
readonly "getDatabaseOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDatabaseOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all children for given database id in the content tree. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each child. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only content that the user has permission to view will be returned.
*/
readonly "getDatabaseDirectChildren": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetDatabaseDirectChildrenParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDatabaseDirectChildren200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns descendants in the content tree for a given database by ID in top-to-bottom order (that is, the highest descendant is the first
* item in the response payload). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available by calling this endpoint with the cursor in the response payload. There is also a `depth` parameter specifying depth
* of descendants to be fetched.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each descendant. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the database and its corresponding space
*/
readonly "getDatabaseDescendants": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetDatabaseDescendantsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDatabaseDescendants200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all ancestors for a given database by ID in top-to-bottom order (that is, the highest ancestor is the first
* item in the response payload). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available by calling this endpoint with the ID of first ancestor in the response payload.
*
* This endpoint returns minimal information about each ancestor. To fetch more details, use a related endpoint, such
* as [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the database and its corresponding space
*/
readonly "getDatabaseAncestors": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetDatabaseAncestorsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDatabaseAncestors200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a Smart Link in the content tree in the space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the corresponding space. Permission to create a Smart Link in the content tree in the space.
*/
readonly "createSmartLink": <Config extends OperationConfig>(options: { readonly payload: typeof CreateSmartLinkRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateSmartLink200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific Smart Link in the content tree.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the Smart Link in the content tree and its corresponding space.
*/
readonly "getSmartLinkById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSmartLinkByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSmartLinkById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a Smart Link in the content tree by id.
*
* Deleting a Smart Link in the content tree moves the Smart Link to the trash, where it can be restored later
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the Smart Link in the content tree and its corresponding space.
* Permission to delete Smart Links in the content tree in the space.
*/
readonly "deleteSmartLink": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves Content Properties tied to a specified Smart Link in the content tree.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the Smart Link in the content tree.
*/
readonly "getSmartLinkContentProperties": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSmartLinkContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSmartLinkContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content property for a Smart Link in the content tree.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the Smart Link in the content tree.
*/
readonly "createSmartLinkProperty": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof CreateSmartLinkPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateSmartLinkProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified Smart Link in the content tree.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the Smart Link in the content tree.
*/
readonly "getSmartLinkContentPropertiesById": <Config extends OperationConfig>(embedId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSmartLinkContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for a Smart Link in the content tree by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the Smart Link in the content tree.
*/
readonly "updateSmartLinkPropertyById": <Config extends OperationConfig>(embedId: string, propertyId: string, options: { readonly payload: typeof UpdateSmartLinkPropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateSmartLinkPropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for a Smart Link in the content tree by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the Smart Link in the content tree.
*/
readonly "deleteSmartLinkPropertyById": <Config extends OperationConfig>(embedId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific Smart Link in the content tree.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the Smart Link in the content tree and its corresponding space.
*/
readonly "getSmartLinkOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSmartLinkOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all children for given smart link id in the content tree. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each child. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only content that the user has permission to view will be returned.
*/
readonly "getSmartLinkDirectChildren": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSmartLinkDirectChildrenParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSmartLinkDirectChildren200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns descendants in the content tree for a given smart link by ID in top-to-bottom order (that is, the highest descendant is the first
* item in the response payload). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available by calling this endpoint with the cursor in the response payload. There is also a `depth` parameter specifying depth
* of descendants to be fetched.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
*
* This endpoint returns minimal information about each descendant. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the smart link and its corresponding space
*/
readonly "getSmartLinkDescendants": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSmartLinkDescendantsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSmartLinkDescendants200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all ancestors for a given Smart Link in the content tree by ID in top-to-bottom order (that is, the highest ancestor is
* the first item in the response payload). The number of results is limited by the `limit` parameter and additional results
* (if available) will be available by calling this endpoint with the ID of first ancestor in the response payload.
*
* This endpoint returns minimal information about each ancestor. To fetch more details, use a related endpoint, such
* as [Get Smart Link in the content tree by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the Smart Link in the content tree and its corresponding space
*/
readonly "getSmartLinkAncestors": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSmartLinkAncestorsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSmartLinkAncestors200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a folder in the space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the corresponding space. Permission to create a folder in the space.
*/
readonly "createFolder": <Config extends OperationConfig>(options: { readonly payload: typeof CreateFolderRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateFolder200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific folder.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the folder and its corresponding space.
*/
readonly "getFolderById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetFolderByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFolderById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a folder by id.
*
* Deleting a folder moves the folder to the trash, where it can be restored later
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the folder and its corresponding space.
* Permission to delete folders in the space.
*/
readonly "deleteFolder": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves Content Properties tied to a specified folder.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the folder.
*/
readonly "getFolderContentProperties": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetFolderContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFolderContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content property for a folder.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the folder.
*/
readonly "createFolderProperty": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof CreateFolderPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateFolderProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified folder.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the folder.
*/
readonly "getFolderContentPropertiesById": <Config extends OperationConfig>(folderId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFolderContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for a folder by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the folder.
*/
readonly "updateFolderPropertyById": <Config extends OperationConfig>(folderId: string, propertyId: string, options: { readonly payload: typeof UpdateFolderPropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateFolderPropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for a folder by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the folder.
*/
readonly "deleteFolderPropertyById": <Config extends OperationConfig>(folderId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific folder.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the folder and its corresponding space.
*/
readonly "getFolderOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFolderOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all children for given folder id in the content tree. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each child. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only content that the user has permission to view will be returned.
*/
readonly "getFolderDirectChildren": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetFolderDirectChildrenParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFolderDirectChildren200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns descendants in the content tree for a given folder by ID in top-to-bottom order (that is, the highest descendant is the first
* item in the response payload). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available by calling this endpoint with the cursor in the response payload. There is also a `depth` parameter specifying depth
* of descendants to be fetched.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each descendant. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the  and its corresponding space
*/
readonly "getFolderDescendants": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetFolderDescendantsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFolderDescendants200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all ancestors for a given folder by ID in top-to-bottom order (that is, the highest ancestor is
* the first item in the response payload). The number of results is limited by the `limit` parameter and additional results
* (if available) will be available by calling this endpoint with the ID of first ancestor in the response payload.
*
* This endpoint returns minimal information about each ancestor. To fetch more details, use a related endpoint, such
* as [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-folders-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the folder and its corresponding space
*/
readonly "getFolderAncestors": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetFolderAncestorsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFolderAncestors200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves version details for the specified page and version number.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page.
*/
readonly "getPageVersionDetails": <Config extends OperationConfig>(pageId: string, versionNumber: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageVersionDetails200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the versions of specific custom content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content and its corresponding page and space.
*/
readonly "getCustomContentVersions": <Config extends OperationConfig>(customContentId: string, options: { readonly params?: typeof GetCustomContentVersionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentVersions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves version details for the specified custom content and version number.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the page.
*/
readonly "getCustomContentVersionDetails": <Config extends OperationConfig>(customContentId: string, versionNumber: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentVersionDetails200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all spaces. The results will be sorted by id ascending. The number of results is limited by the `limit` parameter and
* additional results (if available) will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only spaces that the user has permission to view will be returned.
*/
readonly "getSpaces": <Config extends OperationConfig>(options: { readonly params?: typeof GetSpacesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaces200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a Space as specified in the payload.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to create spaces.
*/
readonly "createSpace": <Config extends OperationConfig>(options: { readonly payload: typeof CreateSpaceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateSpace201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the space.
*/
readonly "getSpaceById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSpaceByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all blog posts in a space. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission) and view the space.
* Only blog posts that the user has permission to view will be returned.
*/
readonly "getBlogPostsInSpace": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogPostsInSpaceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostsInSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the labels of specific space. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the space.
* Only labels that the user has permission to view will be returned.
*/
readonly "getSpaceLabels": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSpaceLabelsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceLabels200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the labels of space content (pages, blogposts etc). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the space.
* Only labels that the user has permission to view will be returned.
*/
readonly "getSpaceContentLabels": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSpaceContentLabelsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceContentLabels200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all custom content for a given type within a given space. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the custom content and the corresponding space.
*/
readonly "getCustomContentByTypeInSpace": <Config extends OperationConfig>(id: string, options: { readonly params: typeof GetCustomContentByTypeInSpaceParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentByTypeInSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the corresponding space.
*/
readonly "getSpaceOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all pages in a space. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission) and 'View' permission for the space.
* Only pages that the user has permission to view will be returned.
*/
readonly "getPagesInSpace": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPagesInSpaceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPagesInSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all properties for the given space. Space properties are a key-value storage associated with a space.
* The limit parameter specifies the maximum number of results returned in a single response. Use the `link` response header
* to paginate through additional results.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission) and 'View' permission for the space.
*/
readonly "getSpaceProperties": <Config extends OperationConfig>(spaceId: string, options: { readonly params?: typeof GetSpacePropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new space property.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission) and 'Admin' permission for the space.
*/
readonly "createSpaceProperty": <Config extends OperationConfig>(spaceId: string, options: { readonly payload: typeof CreateSpacePropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateSpaceProperty201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieve a space property by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission) and 'View' permission for the space.
*/
readonly "getSpacePropertyById": <Config extends OperationConfig>(spaceId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpacePropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a space property by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission) and 'Admin' permission for the space.
*/
readonly "updateSpacePropertyById": <Config extends OperationConfig>(spaceId: string, propertyId: string, options: { readonly payload: typeof UpdateSpacePropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateSpacePropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a space property by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission) and 'Admin' permission for the space.
*/
readonly "deleteSpacePropertyById": <Config extends OperationConfig>(spaceId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns space permission assignments for a specific space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the space.
*/
readonly "getSpacePermissionsAssignments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSpacePermissionsAssignmentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpacePermissionsAssignments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves the available space permissions.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site.
*/
readonly "getAvailableSpacePermissions": <Config extends OperationConfig>(options: { readonly params?: typeof GetAvailableSpacePermissionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAvailableSpacePermissions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Lists the unique unassigned space permission combinations currently present on the tenant.
* Combinations that already map to a space role are filtered out server-side. Each row carries
* the decoded set of space permissions and the principal types that currently hold the
* combination — these inform which `principalType` values are valid to include in the matching
* bulk role-assignments request.
*
* Results are always sorted by `principalCount` descending. Sort field and sort order are not
* configurable; page size is controlled by the `limit` query parameter (default 25, min 1,
* max 250). Use the `cursor` field to page through additional results. The `generatedAt` field
* reflects the last audit run that populated the combinations table — call the
* generate-combinations endpoint to refresh stale data.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a Confluence administrator.
*/
readonly "listSpacePermissionCombinations": <Config extends OperationConfig>(options: { readonly params?: typeof ListSpacePermissionCombinationsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof ListSpacePermissionCombinations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Submits a task to refresh the space permission combinations in the database, which identifies
* all unique permission combinations across the site. This provides permission combination IDs
* that can be used with the assign-roles and remove-access endpoints.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a Confluence administrator.
*/
readonly "generateSpacePermissionCombinations": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GenerateSpacePermissionCombinations202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Bulk assigns roles for one or more permission combination IDs obtained from the space permission
* combinations. Supports targeting all spaces, specific spaces, or excluding specific spaces.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a Confluence administrator.
*/
readonly "bulkAssignSpacePermissionRoles": <Config extends OperationConfig>(options: { readonly payload: typeof BulkAssignSpacePermissionRolesRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof BulkAssignSpacePermissionRoles202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Bulk removes access for one or more permission combination IDs obtained from the space permission
* combinations. This removes all space permissions for the specified combinations across
* the targeted spaces.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a Confluence administrator.
*/
readonly "bulkRemoveSpacePermissionAccess": <Config extends OperationConfig>(options: { readonly payload: typeof BulkRemoveSpacePermissionAccessRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof BulkRemoveSpacePermissionAccess202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves the status of an async space permission transition task. Use the taskId returned
* from the generate-combinations, assign-roles, or remove-access endpoints to poll for
* progress and completion.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a Confluence administrator.
*/
readonly "getSpacePermissionTransitionTaskStatus": <Config extends OperationConfig>(taskId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpacePermissionTransitionTaskStatus200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves the available space roles.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site; if requesting a certain space's roles, permission to view the space.
*/
readonly "getAvailableSpaceRoles": <Config extends OperationConfig>(options: { readonly params?: typeof GetAvailableSpaceRolesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAvailableSpaceRoles200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create a space role.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be an organization or site admin. Connect and Forge app users are not authorized to access this resource.
*/
readonly "createSpaceRole": <Config extends OperationConfig>(options: { readonly payload: typeof CreateSpaceRoleRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateSpaceRole201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves the space role by ID.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site.
*/
readonly "getSpaceRolesById": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceRolesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a space role.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be an organization or site admin. Connect and Forge app users are not authorized to access this resource.
*/
readonly "updateSpaceRole": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof UpdateSpaceRoleRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateSpaceRole202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a space role
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be an organization or site admin. Connect and Forge app users are not authorized to access this resource.
*/
readonly "deleteSpaceRole": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteSpaceRole202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves the space role mode.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getSpaceRoleMode": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceRoleMode200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves the space role assignments.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the space.
*/
readonly "getSpaceRoleAssignments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetSpaceRoleAssignmentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceRoleAssignments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Sets space role assignments as specified in the payload. For each entry, if `roleId` is provided
* the principal is assigned to that role. If `roleId` is omitted, the role assignment for that principal is removed, if it exists.
*
* Available on tenants with [Role-Based Access Control](https://support.atlassian.com/confluence-cloud/docs/manage-user-roles/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to manage roles in the space.
*/
readonly "setSpaceRoleAssignments": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof SetSpaceRoleAssignmentsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetSpaceRoleAssignments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the root footer comments of specific page. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getPageFooterComments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageFooterCommentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageFooterComments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the root inline comments of specific page. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getPageInlineComments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageInlineCommentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageInlineComments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the root footer comments of specific blog post. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the blog post and its corresponding space.
*/
readonly "getBlogPostFooterComments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogPostFooterCommentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostFooterComments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the root inline comments of specific blog post. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the blog post and its corresponding space.
*/
readonly "getBlogPostInlineComments": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogPostInlineCommentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostInlineComments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all footer comments. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the container and its corresponding space.
*/
readonly "getFooterComments": <Config extends OperationConfig>(options: { readonly params?: typeof GetFooterCommentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFooterComments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create a footer comment.
*
* The footer comment can be made against several locations:
* - at the top level (specifying pageId or blogPostId in the request body)
* - as a reply (specifying parentCommentId in the request body)
* - against an attachment (note: this is different than the comments added via the attachment properties page on the UI, which are referred to as version comments)
* - against a custom content
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space. Permission to create comments in the space.
*/
readonly "createFooterComment": <Config extends OperationConfig>(options: { readonly payload: typeof CreateFooterCommentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateFooterComment201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a footer comment by id
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the container and its corresponding space.
*/
readonly "getFooterCommentById": <Config extends OperationConfig>(commentId: string, options: { readonly params?: typeof GetFooterCommentByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFooterCommentById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a footer comment. This can be used to update the body text of a comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space. Permission to create comments in the space.
*/
readonly "updateFooterComment": <Config extends OperationConfig>(commentId: string, options: { readonly payload: typeof UpdateFooterCommentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateFooterComment200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a footer comment. This is a permanent deletion and cannot be reverted.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space. Permission to delete comments in the space.
*/
readonly "deleteFooterComment": <Config extends OperationConfig>(commentId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the children footer comments of specific comment. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getFooterCommentChildren": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetFooterCommentChildrenParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFooterCommentChildren200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the count of likes of specific footer comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page/blogpost and its corresponding space.
*/
readonly "getFooterLikeCount": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFooterLikeCount200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the account IDs of likes of specific footer comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page/blogpost and its corresponding space.
*/
readonly "getFooterLikeUsers": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetFooterLikeUsersParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFooterLikeUsers200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific footer comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the parent content of the footer comment and its corresponding space.
*/
readonly "getFooterCommentOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFooterCommentOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves the versions of the specified footer comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blog post and its corresponding space.
*/
readonly "getFooterCommentVersions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetFooterCommentVersionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFooterCommentVersions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves version details for the specified footer comment version.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blog post and its corresponding space.
*/
readonly "getFooterCommentVersionDetails": <Config extends OperationConfig>(id: string, versionNumber: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetFooterCommentVersionDetails200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all inline comments. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getInlineComments": <Config extends OperationConfig>(options: { readonly params?: typeof GetInlineCommentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInlineComments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create an inline comment. This can be at the top level (specifying pageId or blogPostId in the request body)
* or as a reply (specifying parentCommentId in the request body). Note the inlineCommentProperties object in the
* request body is used to select the text the inline comment should be tied to. This is what determines the text
* highlighting when viewing a page in Confluence.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space. Permission to create comments in the space.
*/
readonly "createInlineComment": <Config extends OperationConfig>(options: { readonly payload: typeof CreateInlineCommentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateInlineComment201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves an inline comment by id
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space.
*/
readonly "getInlineCommentById": <Config extends OperationConfig>(commentId: string, options: { readonly params?: typeof GetInlineCommentByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInlineCommentById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update an inline comment. This can be used to update the body text of a comment and/or to resolve the comment
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space. Permission to create comments in the space.
*/
readonly "updateInlineComment": <Config extends OperationConfig>(commentId: string, options: { readonly payload: typeof UpdateInlineCommentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateInlineComment200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes an inline comment. This is a permanent deletion and cannot be reverted.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blogpost and its corresponding space. Permission to delete comments in the space.
*/
readonly "deleteInlineComment": <Config extends OperationConfig>(commentId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the children inline comments of specific comment. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page and its corresponding space.
*/
readonly "getInlineCommentChildren": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetInlineCommentChildrenParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInlineCommentChildren200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the count of likes of specific inline comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page/blogpost and its corresponding space.
*/
readonly "getInlineLikeCount": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInlineLikeCount200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the account IDs of likes of specific inline comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page/blogpost and its corresponding space.
*/
readonly "getInlineLikeUsers": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetInlineLikeUsersParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInlineLikeUsers200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the permitted operations on specific inline comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the parent content of the inline comment and its corresponding space.
*/
readonly "getInlineCommentOperations": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInlineCommentOperations200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves the versions of the specified inline comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blog post and its corresponding space.
*/
readonly "getInlineCommentVersions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetInlineCommentVersionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInlineCommentVersions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves version details for the specified inline comment version.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content of the page or blog post and its corresponding space.
*/
readonly "getInlineCommentVersionDetails": <Config extends OperationConfig>(id: string, versionNumber: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInlineCommentVersionDetails200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves Content Properties attached to a specified comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the comment.
*/
readonly "getCommentContentProperties": <Config extends OperationConfig>(commentId: string, options: { readonly params?: typeof GetCommentContentPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCommentContentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content property for a comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the comment.
*/
readonly "createCommentProperty": <Config extends OperationConfig>(commentId: string, options: { readonly payload: typeof CreateCommentPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateCommentProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a specific Content Property by ID that is attached to a specified comment.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the comment.
*/
readonly "getCommentContentPropertiesById": <Config extends OperationConfig>(commentId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCommentContentPropertiesById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a content property for a comment by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the comment.
*/
readonly "updateCommentPropertyById": <Config extends OperationConfig>(commentId: string, propertyId: string, options: { readonly payload: typeof UpdateCommentPropertyByIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateCommentPropertyById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a content property for a comment by its id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the comment.
*/
readonly "deleteCommentPropertyById": <Config extends OperationConfig>(commentId: string, propertyId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all tasks. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only tasks that the user has permission to view will be returned.
*/
readonly "getTasks": <Config extends OperationConfig>(options: { readonly params?: typeof GetTasksParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTasks200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a specific task.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the containing page or blog post and its corresponding space.
*/
readonly "getTaskById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetTaskByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTaskById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a task by id. This endpoint currently only supports updating task status.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the containing page or blog post and view its corresponding space.
*/
readonly "updateTask": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof UpdateTaskParams.Encoded | undefined; readonly payload: typeof UpdateTaskRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateTask200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all child pages for given page id. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only pages that the user has permission to view will be returned.
*/
readonly "getChildPages": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetChildPagesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetChildPages200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all child custom content for given custom content id. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only custom content that the user has permission to view will be returned.
*/
readonly "getChildCustomContent": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetChildCustomContentParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetChildCustomContent200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all children for given page id in the content tree. The number of results is limited by the `limit` parameter and additional results (if available)
* will be available through the `next` URL present in the `Link` response header.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each child. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only content that the user has permission to view will be returned.
*/
readonly "getPageDirectChildren": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageDirectChildrenParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageDirectChildren200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all ancestors for a given page by ID in top-to-bottom order (that is, the highest ancestor is the first
* item in the response payload). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available by calling this endpoint with the ID of first ancestor in the response payload.
*
* This endpoint returns minimal information about each ancestor. To fetch more details, use a related endpoint, such
* as [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getPageAncestors": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageAncestorsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageAncestors200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns descendants in the content tree for a given page by ID in top-to-bottom order (that is, the highest descendant is the first
* item in the response payload). The number of results is limited by the `limit` parameter and additional results (if available)
* will be available by calling this endpoint with the cursor in the response payload. There is also a `depth` parameter specifying depth
* of descendants to be fetched.
*
* The following types of content will be returned:
* - Database
* - Embed
* - Folder
* - Page
* - Whiteboard
*
* This endpoint returns minimal information about each descendant. To fetch more details, use a related endpoint based on the content type, such
* as:
*
* - [Get database by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-database/#api-databases-id-get)
* - [Get embed by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-smart-link/#api-embeds-id-get)
* - [Get folder by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/#api-folders-id-get)
* - [Get page by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)
* - [Get whiteboard by id](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-whiteboard/#api-whiteboards-id-get).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Permission to view the page and its corresponding space
*/
readonly "getPageDescendants": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageDescendantsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageDescendants200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns user details for the ids provided in the request body.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* The user must be able to view user profiles in the Confluence site.
*/
readonly "createBulkUserLookup": <Config extends OperationConfig>(options: { readonly payload: typeof CreateBulkUserLookupRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateBulkUserLookup200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the list of emails from the input list that do not have access to site.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "checkAccessByEmail": <Config extends OperationConfig>(options: { readonly payload: typeof CheckAccessByEmailRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CheckAccessByEmail200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Invite a list of emails to the site.
*
* Ignores all invalid emails and no action is taken for the emails that already have access to the site.
*
* <b>NOTE:</b> This API is asynchronous and may take some time to complete.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "inviteByEmail": <Config extends OperationConfig>(options: { readonly payload: typeof InviteByEmailRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns data policy metadata for the workspace.
*
* **[Permissions](#permissions) required:**
* Only apps can make this request.
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getDataPolicyMetadata": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDataPolicyMetadata200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all spaces. The results will be sorted by id ascending. The number of results is limited by the `limit` parameter and
* additional results (if available) will be available through the `next` URL present in the `Link` response header.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Only apps can make this request.
* Permission to access the Confluence site ('Can use' global permission).
* Only spaces that the app has permission to view will be returned.
*/
readonly "getDataPolicySpaces": <Config extends OperationConfig>(options: { readonly params?: typeof GetDataPolicySpacesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDataPolicySpaces200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a list of [classification levels](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* available.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getClassificationLevels": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetClassificationLevels200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the [default classification level](https://support.atlassian.com/security-and-access-policies/docs/what-is-a-default-classification-level/)
* for a specific space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the space.
*/
readonly "getSpaceDefaultClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceDefaultClassificationLevel200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update the [default classification level](https://support.atlassian.com/security-and-access-policies/docs/what-is-a-default-classification-level/)
* for a specific space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and 'Admin' permission for the space.
*/
readonly "putSpaceDefaultClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PutSpaceDefaultClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the [default classification level](https://support.atlassian.com/security-and-access-policies/docs/what-is-a-default-classification-level/)
* for a specific space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and 'Admin' permission for the space.
*/
readonly "deleteSpaceDefaultClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the page.
* 'Permission to edit the page is required if trying to view classification level for a draft.
*/
readonly "getPageClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetPageClassificationLevelParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPageClassificationLevel200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific page.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to edit the page.
*/
readonly "putPageClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PutPageClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Resets the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific page for the space
* [default classification level](https://support.atlassian.com/security-and-access-policies/docs/what-is-a-default-classification-level/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the page.
*/
readonly "postPageClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PostPageClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the blog post.
* 'Permission to edit the blog post is required if trying to view classification level for a draft.
*/
readonly "getBlogPostClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetBlogPostClassificationLevelParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlogPostClassificationLevel200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific blog post.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to edit the blog post.
*/
readonly "putBlogPostClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PutBlogPostClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Resets the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific blog post for the space
* [default classification level](https://support.atlassian.com/security-and-access-policies/docs/what-is-a-default-classification-level/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the blog post.
*/
readonly "postBlogPostClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PostBlogPostClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific whiteboard.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the whiteboard.
*/
readonly "getWhiteboardClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWhiteboardClassificationLevel200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific whiteboard.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to edit the whiteboard.
*/
readonly "putWhiteboardClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PutWhiteboardClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Resets the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific whiteboard for the space
* [default classification level](https://support.atlassian.com/security-and-access-policies/docs/what-is-a-default-classification-level/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the whiteboard.
*/
readonly "postWhiteboardClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PostWhiteboardClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific database.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the database.
*/
readonly "getDatabaseClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDatabaseClassificationLevel200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific database.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to edit the database.
*/
readonly "putDatabaseClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PutDatabaseClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Resets the [classification level](https://developer.atlassian.com/cloud/admin/dlp/rest/intro/#Classification%20level)
* for a specific database for the space
* [default classification level](https://support.atlassian.com/security-and-access-policies/docs/what-is-a-default-classification-level/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Permission to access the Confluence site ('Can use' global permission) and permission to view the database.
*/
readonly "postDatabaseClassificationLevel": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof PostDatabaseClassificationLevelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Redirects the client to a URL that serves an attachment thumbnail's binary data.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the attachment's container.
*/
readonly "getAttachmentThumbnailById": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetAttachmentThumbnailByIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Gets Forge app properties. This API can only be accessed using **[asApp()](https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestconfluence/#method-signature)** requests from Forge.
*/
readonly "getForgeAppProperties": <Config extends OperationConfig>(options: { readonly params?: typeof GetForgeAppPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetForgeAppProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Gets a Forge app property by property key. This API can only be accessed using **[asApp()](https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestconfluence/#method-signature)** requests from Forge.
*/
readonly "getForgeAppProperty": <Config extends OperationConfig>(propertyKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetForgeAppProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates or updates a Forge app property. This API can only be accessed using **[asApp()](https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestconfluence/#method-signature)** requests from Forge.
*/
readonly "putForgeAppProperty": <Config extends OperationConfig>(propertyKey: string, options: { readonly payload: typeof PutForgeAppPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a Forge app property. This API can only be accessed using **[asApp()](https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestconfluence/#method-signature)** requests from Forge.
*/
readonly "deleteForgeAppProperty": <Config extends OperationConfig>(propertyKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
}

export interface ConfluenceV2ApiError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class ConfluenceV2ApiErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const ConfluenceV2ApiError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): ConfluenceV2ApiError<Tag, E> =>
  new ConfluenceV2ApiErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any
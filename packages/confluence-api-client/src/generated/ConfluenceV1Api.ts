import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { SchemaError } from "effect/Schema"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
// recursive declarations
export type User = { readonly "type": "known" | "unknown" | "anonymous" | "user", readonly "username"?: GenericUserName, readonly "userKey"?: GenericUserKey, readonly "accountId"?: GenericAccountId, readonly "accountType"?: "atlassian" | "app" | "", readonly "email"?: string | null, readonly "publicName"?: string, readonly "profilePicture"?: Icon, readonly "displayName"?: string | null, readonly "timeZone"?: string | null, readonly "externalCollaborator"?: boolean, readonly "isExternalCollaborator"?: boolean, readonly "isGuest"?: boolean, readonly "operations"?: ReadonlyArray<{ readonly "operation": "administer" | "archive" | "clear_permissions" | "copy" | "create" | "create_space" | "delete" | "export" | "move" | "purge" | "purge_version" | "read" | "restore" | "restrict_content" | "update" | "use", readonly "targetType": string }>, readonly "details"?: UserDetails, readonly "personalSpace"?: Space, readonly "_expandable"?: { readonly "operations"?: string, readonly "details"?: string, readonly "personalSpace"?: string }, readonly "_links"?: GenericLinks }
export const User = Schema.suspend((): Schema.Codec<User> => __recursive_User)
export type Space = { readonly "id"?: number, readonly "key": string, readonly "alias"?: string, readonly "name": string, readonly "icon"?: Icon, readonly "description"?: { readonly "plain"?: SpaceDescription, readonly "view"?: SpaceDescription, readonly "_expandable"?: { readonly "view"?: string, readonly "plain"?: string } }, readonly "homepage"?: Content, readonly "type": string, readonly "metadata"?: { readonly "labels"?: LabelArray, readonly "_expandable"?: {  } }, readonly "operations"?: ReadonlyArray<OperationCheckResult>, readonly "permissions"?: ReadonlyArray<Schema.Json>, readonly "status": string, readonly "settings"?: SpaceSettings, readonly "theme"?: Theme, readonly "lookAndFeel"?: LookAndFeel, readonly "history"?: { readonly "createdDate": string, readonly "createdBy"?: User }, readonly "_expandable": { readonly "settings"?: string, readonly "metadata"?: string, readonly "operations"?: string, readonly "lookAndFeel"?: string, readonly "permissions"?: string, readonly "icon"?: string, readonly "description"?: string, readonly "theme"?: string, readonly "history"?: string, readonly "homepage"?: string, readonly "identifiers"?: string }, readonly "_links": GenericLinks }
export const Space = Schema.suspend((): Schema.Codec<Space> => __recursive_Space)
// non-recursive definitions
export type AccountId = { readonly "accountId": string }
export const AccountId = Schema.Struct({ "accountId": Schema.String })
export type AccountIdEmailRecord = { readonly "accountId": string, readonly "email": string }
export const AccountIdEmailRecord = Schema.Struct({ "accountId": Schema.String, "email": Schema.String })
export type AffectedObject = { readonly "name": string, readonly "objectType": string }
export const AffectedObject = Schema.Struct({ "name": Schema.String, "objectType": Schema.String })
export type AsyncId = { readonly "asyncId": string }
export const AsyncId = Schema.Struct({ "asyncId": Schema.String })
export type ButtonLookAndFeel = { readonly "backgroundColor": string, readonly "color": string }
export const ButtonLookAndFeel = Schema.Union([Schema.Struct({ "backgroundColor": Schema.String, "color": Schema.String })])
export type Breadcrumb = { readonly "label": string, readonly "url": string, readonly "separator": string }
export const Breadcrumb = Schema.Struct({ "label": Schema.String, "url": Schema.String, "separator": Schema.String })
export type ChangedValue = { readonly "name": string, readonly "oldValue": string, readonly "hiddenOldValue"?: string, readonly "newValue": string, readonly "hiddenNewValue"?: string }
export const ChangedValue = Schema.Struct({ "name": Schema.String, "oldValue": Schema.String, "hiddenOldValue": Schema.optionalKey(Schema.String), "newValue": Schema.String, "hiddenNewValue": Schema.optionalKey(Schema.String) })
export type ConnectModule = {  }
export const ConnectModule = Schema.Struct({  }).annotate({ "description": "A [Connect module](https://developer.atlassian.com/cloud/confluence/modules/admin-page/) in the same format as in the\n[app descriptor](https://developer.atlassian.com/cloud/confluence/app-descriptor/)." })
export type Container = {  }
export const Container = Schema.Union([Schema.Struct({  }).annotate({ "description": "Container for content. This can be either a space (containing a page or blogpost)\nor a page/blog post (containing an attachment or comment)" })])
export type ContainerLookAndFeel = { readonly "background": string, readonly "backgroundAttachment"?: string | null, readonly "backgroundBlendMode"?: string | null, readonly "backgroundClip"?: string | null, readonly "backgroundColor": string | null, readonly "backgroundImage": string | null, readonly "backgroundOrigin"?: string | null, readonly "backgroundPosition"?: string | null, readonly "backgroundRepeat"?: string | null, readonly "backgroundSize": string | null, readonly "padding": string, readonly "borderRadius": string }
export const ContainerLookAndFeel = Schema.Union([Schema.Struct({ "background": Schema.String, "backgroundAttachment": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundBlendMode": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundClip": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundColor": Schema.Union([Schema.String, Schema.Null]), "backgroundImage": Schema.Union([Schema.String, Schema.Null]), "backgroundOrigin": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundPosition": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundRepeat": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundSize": Schema.Union([Schema.String, Schema.Null]), "padding": Schema.String, "borderRadius": Schema.String })])
export type ContainerSummary = { readonly "title": string, readonly "displayUrl": string }
export const ContainerSummary = Schema.Struct({ "title": Schema.String, "displayUrl": Schema.String })
export type Content = Schema.Json
export const Content = Schema.Json
export type ContentBlueprintDraft = { readonly "version": { readonly "number": number, readonly [x: string]: Schema.Json }, readonly "title": string, readonly "type": "page", readonly "status"?: "current", readonly "space"?: { readonly "key": string, readonly [x: string]: Schema.Json }, readonly "ancestors"?: ReadonlyArray<{ readonly "id": string }>, readonly [x: string]: Schema.Json }
export const ContentBlueprintDraft = Schema.StructWithRest(Schema.Struct({ "version": Schema.StructWithRest(Schema.Struct({ "number": Schema.Number.annotate({ "description": "The version number. Set this to `1`.", "format": "int32" }).check(Schema.isInt()) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "The version for the new content." }), "title": Schema.String.annotate({ "description": "The title of the content. If you don't want to change the title,\nset this to the current title of the draft." }).check(Schema.isMaxLength(255)), "type": Schema.Literal("page").annotate({ "description": "The type of content. Set this to `page`." }), "status": Schema.optionalKey(Schema.Literal("current").annotate({ "description": "The status of the content. Set this to `current` or omit it altogether." })), "space": Schema.optionalKey(Schema.StructWithRest(Schema.Struct({ "key": Schema.String.annotate({ "description": "The key of the space", "format": "int32" }) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "The space for the content." })), "ancestors": Schema.optionalKey(Schema.Union([Schema.Array(Schema.Struct({ "id": Schema.String.annotate({ "description": "The content ID of the ancestor." }) })).annotate({ "description": "The new ancestor (i.e. parent page) for the content. If you have\nspecified an ancestor, you must also specify a `space` property\nin the request body for the space that the ancestor is in.\n\nNote, if you specify more than one ancestor, the last ID in the array\nwill be selected as the parent page for the content." })])) }), [Schema.Record(Schema.String, Schema.Json)])
export type ContentBodyCreate = { readonly "value": string, readonly "representation": "view" | "export_view" | "styled_view" | "storage" | "editor" | "editor2" | "anonymous_export_view" | "wiki" | "atlas_doc_format" | "plain" | "raw", readonly [x: string]: Schema.Json }
export const ContentBodyCreate = Schema.StructWithRest(Schema.Struct({ "value": Schema.String.annotate({ "description": "The body of the content in the relevant format." }), "representation": Schema.Literals(["view", "export_view", "styled_view", "storage", "editor", "editor2", "anonymous_export_view", "wiki", "atlas_doc_format", "plain", "raw"]).annotate({ "description": "The content format type. Set the value of this property to\nthe name of the format being used, e.g. 'storage'." }) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "This object is used when creating or updating content." })
export type ContentBodyCreateStorage = { readonly "value": string, readonly "representation": "storage" | "view" | "export_view" | "styled_view" | "editor" | "editor2" | "anonymous_export_view" | "wiki" | "atlas_doc_format", readonly [x: string]: Schema.Json }
export const ContentBodyCreateStorage = Schema.StructWithRest(Schema.Struct({ "value": Schema.String.annotate({ "description": "The body of the content in the relevant format." }), "representation": Schema.Literals(["storage", "view", "export_view", "styled_view", "editor", "editor2", "anonymous_export_view", "wiki", "atlas_doc_format"]).annotate({ "description": "The content format type. Set the value of this property to\nthe name of the format being used, e.g. 'storage'." }) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "This object is used when creating or updating content." })
export type ContentId = string
export const ContentId = Schema.String
export type ContentState = { readonly "id": number, readonly "name": string, readonly "color": string }
export const ContentState = Schema.Struct({ "id": Schema.Number.annotate({ "description": "identifier of content state. If 0, 1, or 2, this is a default space state", "format": "int64" }).check(Schema.isInt()), "name": Schema.String.annotate({ "description": "name of content state." }), "color": Schema.String.annotate({ "description": "hex string representing color of state" }) })
export type ContentStateRestInput = { readonly "name"?: string, readonly "color"?: string, readonly "id"?: number }
export const ContentStateRestInput = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "Name of content state. Maximum 20 characters." })), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Color of state. Must be in 6 digit hex form (#FFFFFF). The default colors offered in the UI are:\n #ff7452 (red),\n #2684ff (blue),\n #ffc400 (yellow),\n #57d9a3 (green), and\n #8777d9 (purple)" })), "id": Schema.optionalKey(Schema.Number.annotate({ "description": "id of state. This can be 0,1, or 2 if you wish to specify a default space state.", "format": "int64" }).check(Schema.isInt())) })
export type ContentStateResponse = { readonly "contentState"?: { readonly "id": number, readonly "name": string, readonly "color": string }, readonly "lastUpdated"?: string }
export const ContentStateResponse = Schema.Struct({ "contentState": Schema.optionalKey(Schema.Struct({ "id": Schema.Number.annotate({ "description": "identifier of content state. If 0, 1, or 2, this is a default space state", "format": "int64" }).check(Schema.isInt()), "name": Schema.String.annotate({ "description": "name of content state." }), "color": Schema.String.annotate({ "description": "hex string representing color of state" }) }).annotate({ "description": "Null or content state" })), "lastUpdated": Schema.optionalKey(Schema.String.annotate({ "description": "Timestamp of last publish event where content state changed" })) })
export type CopyPageHierarchyTitleOptions = { readonly "prefix"?: string, readonly "replace"?: string, readonly "search"?: string }
export const CopyPageHierarchyTitleOptions = Schema.Struct({ "prefix": Schema.optionalKey(Schema.String), "replace": Schema.optionalKey(Schema.String), "search": Schema.optionalKey(Schema.String) }).annotate({ "description": "Required for copying page in the same space." })
export type CopyPageRequestDestination = { readonly "type": "space" | "existing_page" | "parent_page" | "parent_content", readonly "value": string }
export const CopyPageRequestDestination = Schema.Struct({ "type": Schema.Literals(["space", "existing_page", "parent_page", "parent_content"]), "value": Schema.String.annotate({ "description": "The space key for `space` type, and content id for `parent_page`, `parent_content`, and `existing_page`" }) }).annotate({ "description": "Defines where the page will be copied to, and can be one of the following types.\n\n  - `parent_page`: page will be copied as a child of the specified parent page\n  - `parent_content`: page will be copied as a child of the specified parent content\n  - `space`: page will be copied to the specified space as a root page on the space\n  - `existing_page`: page will be copied and replace the specified page" })
export type Embeddable = { readonly [x: string]: Schema.Json }
export const Embeddable = Schema.Record(Schema.String, Schema.Json)
export type GenericAccountId = string | null
export const GenericAccountId = Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The account ID of the user, which uniquely identifies the user across all Atlassian products.\nFor example, `384093:32b4d9w0-f6a5-3535-11a3-9c8c88d10192`." })
export type GenericLinks = { readonly [x: string]: { readonly [x: string]: Schema.Json } | string }
export const GenericLinks = Schema.Record(Schema.String, Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.String], { mode: "oneOf" }))
export type GenericUserName = string | null
export const GenericUserName = Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "This property is no longer available and will be removed from the documentation soon.\nUse `accountId` instead.\nSee the [deprecation notice](/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/) for details." })
export type GenericUserKey = string | null
export const GenericUserKey = Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "This property is no longer available and will be removed from the documentation soon.\nUse `accountId` instead.\nSee the [deprecation notice](/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/) for details." })
export type GlobalSpaceIdentifier = { readonly "spaceIdentifier": string }
export const GlobalSpaceIdentifier = Schema.Union([Schema.Struct({ "spaceIdentifier": Schema.String })])
export type GroupCreate = { readonly "type": "group", readonly "id"?: string, readonly [x: string]: Schema.Json }
export const GroupCreate = Schema.StructWithRest(Schema.Struct({ "type": Schema.Literal("group"), "id": Schema.optionalKey(Schema.String) }), [Schema.Record(Schema.String, Schema.Json)])
export type GroupName = { readonly "name": string }
export const GroupName = Schema.Struct({ "name": Schema.String })
export type Icon = { readonly "path": string, readonly "width": number, readonly "height": number, readonly "isDefault": boolean }
export const Icon = Schema.Union([Schema.Struct({ "path": Schema.String, "width": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "height": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "isDefault": Schema.Boolean }).annotate({ "description": "This object represents an icon. If used as a profilePicture, this may be returned as null, depending on the user's privacy setting." })])
export type Label = { readonly "prefix": string, readonly "name": string, readonly "id": string, readonly "label": string }
export const Label = Schema.Struct({ "prefix": Schema.String, "name": Schema.String, "id": Schema.String, "label": Schema.String })
export type LabeledContentType = "page" | "blogpost" | "attachment" | "page_template"
export const LabeledContentType = Schema.Literals(["page", "blogpost", "attachment", "page_template"])
export type LabelCreate = { readonly "prefix": string, readonly "name": string, readonly [x: string]: Schema.Json }
export const LabelCreate = Schema.StructWithRest(Schema.Struct({ "prefix": Schema.String.annotate({ "description": "The prefix for the label. `global`, `my` `team`, etc." }), "name": Schema.String.annotate({ "description": "The name of the label, which will be shown in the UI." }) }), [Schema.Record(Schema.String, Schema.Json)])
export type LongTask = { readonly "ari"?: string, readonly "id": string, readonly "links": { readonly "status"?: string, readonly [x: string]: Schema.Json } }
export const LongTask = Schema.Struct({ "ari": Schema.optionalKey(Schema.String.annotate({ "description": "the ARI for the long task, based on its ID" })), "id": Schema.String.annotate({ "description": "a unique identifier for the long task" }), "links": Schema.StructWithRest(Schema.Struct({ "status": Schema.optionalKey(Schema.String.annotate({ "description": "The URL to retrive status of long task." })) }), [Schema.Record(Schema.String, Schema.Json)]) })
export type LookAndFeelSelection = { readonly "spaceKey": string, readonly "lookAndFeelType": "global" | "custom" | "theme" }
export const LookAndFeelSelection = Schema.Struct({ "spaceKey": Schema.String.annotate({ "description": "The key of the space for which the look and feel settings will be\nset." }), "lookAndFeelType": Schema.Literals(["global", "custom", "theme"]) }).annotate({ "description": "Look and feel selection" })
export type MenusLookAndFeel = { readonly "hoverOrFocus": { readonly "backgroundColor": string }, readonly "color": string }
export const MenusLookAndFeel = Schema.Struct({ "hoverOrFocus": Schema.Struct({ "backgroundColor": Schema.String }), "color": Schema.String })
export type Message = { readonly "translation"?: string, readonly "args": ReadonlyArray<string | { readonly [x: string]: Schema.Json }>, readonly [x: string]: Schema.Json }
export const Message = Schema.StructWithRest(Schema.Struct({ "translation": Schema.optionalKey(Schema.String), "args": Schema.Array(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Json)], { mode: "oneOf" })) }), [Schema.Record(Schema.String, Schema.Json)])
export type NavigationLookAndFeel = { readonly "color": string, readonly "highlightColor"?: string | null, readonly "hoverOrFocus": { readonly "backgroundColor": string, readonly "color": string } }
export const NavigationLookAndFeel = Schema.Union([Schema.Struct({ "color": Schema.String, "highlightColor": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "hoverOrFocus": Schema.Struct({ "backgroundColor": Schema.String, "color": Schema.String }) })])
export type TopNavigationLookAndFeel = { readonly "color"?: string | null, readonly "highlightColor": string, readonly "hoverOrFocus"?: { readonly "backgroundColor"?: string, readonly "color"?: string } }
export const TopNavigationLookAndFeel = Schema.Struct({ "color": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "highlightColor": Schema.String, "hoverOrFocus": Schema.optionalKey(Schema.Struct({ "backgroundColor": Schema.optionalKey(Schema.String), "color": Schema.optionalKey(Schema.String) })) })
export type OperationCheckResult = { readonly "operation": "administer" | "archive" | "clear_permissions" | "copy" | "create" | "create_space" | "delete" | "export" | "move" | "purge" | "purge_version" | "read" | "restore" | "restrict_content" | "update" | "use", readonly "targetType": string }
export const OperationCheckResult = Schema.Struct({ "operation": Schema.Literals(["administer", "archive", "clear_permissions", "copy", "create", "create_space", "delete", "export", "move", "purge", "purge_version", "read", "restore", "restrict_content", "update", "use"]).annotate({ "description": "The operation itself." }), "targetType": Schema.String.annotate({ "description": "The space or content type that the operation applies to. Could be one of- - application - page - blogpost - comment - attachment - space" }) }).annotate({ "description": "An operation and the target entity that it applies to, e.g. create page." })
export type PropertyValue = ReadonlyArray<string> | boolean | { readonly [x: string]: Schema.Json } | string
export const PropertyValue = Schema.Union([Schema.Array(Schema.String), Schema.Boolean, Schema.Record(Schema.String, Schema.Json), Schema.String], { mode: "oneOf" }).annotate({ "description": "The value of the property. This can be empty or a complex object. 64KB Size Limit\nFor example,\n```\n\"value\": {\n  \"example1\": \"value\",\n  \"example2\": true,\n  \"example3\": 123,\n  \"example4\": [\"value1\", \"value2\"],\n}\n```" })
export type RelationData = { readonly "createdBy"?: User, readonly "createdDate"?: string, readonly "friendlyCreatedDate"?: string }
export const RelationData = Schema.Struct({ "createdBy": Schema.optionalKey(User), "createdDate": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "friendlyCreatedDate": Schema.optionalKey(Schema.String) })
export type RetentionPeriod = { readonly "number": number, readonly "units": "NANOS" | "MICROS" | "MILLIS" | "SECONDS" | "MINUTES" | "HOURS" | "HALF_DAYS" | "DAYS" | "WEEKS" | "MONTHS" | "YEARS" | "DECADES" | "CENTURIES" | "MILLENNIA" | "ERAS" | "FOREVER" }
export const RetentionPeriod = Schema.Struct({ "number": Schema.Number.annotate({ "description": "The number of units for the retention period.", "format": "int32" }).check(Schema.isInt()), "units": Schema.Literals(["NANOS", "MICROS", "MILLIS", "SECONDS", "MINUTES", "HOURS", "HALF_DAYS", "DAYS", "WEEKS", "MONTHS", "YEARS", "DECADES", "CENTURIES", "MILLENNIA", "ERAS", "FOREVER"]).annotate({ "description": "The unit of time that the retention period is measured in." }) })
export type ScreenLookAndFeel = { readonly "background": string, readonly "backgroundAttachment"?: string | null, readonly "backgroundBlendMode"?: string | null, readonly "backgroundClip"?: string | null, readonly "backgroundColor"?: string | null, readonly "backgroundImage"?: string | null, readonly "backgroundOrigin"?: string | null, readonly "backgroundPosition"?: string | null, readonly "backgroundRepeat"?: string | null, readonly "backgroundSize"?: string | null, readonly "layer"?: { readonly "width"?: string, readonly "height"?: string }, readonly "gutterTop"?: string | null, readonly "gutterRight"?: string | null, readonly "gutterBottom"?: string | null, readonly "gutterLeft"?: string | null }
export const ScreenLookAndFeel = Schema.Struct({ "background": Schema.String, "backgroundAttachment": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundBlendMode": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundClip": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundColor": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundImage": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundOrigin": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundPosition": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundRepeat": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "backgroundSize": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "layer": Schema.optionalKey(Schema.Union([Schema.Struct({ "width": Schema.optionalKey(Schema.String), "height": Schema.optionalKey(Schema.String) })])), "gutterTop": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "gutterRight": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "gutterBottom": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "gutterLeft": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])) })
export type SearchFieldLookAndFeel = { readonly "backgroundColor": string, readonly "color": string }
export const SearchFieldLookAndFeel = Schema.Union([Schema.Struct({ "backgroundColor": Schema.String, "color": Schema.String })])
export type SpaceDescription = { readonly "value": string, readonly "representation": "plain" | "view", readonly "embeddedContent": ReadonlyArray<{  }>, readonly [x: string]: Schema.Json }
export const SpaceDescription = Schema.StructWithRest(Schema.Struct({ "value": Schema.String, "representation": Schema.Literals(["plain", "view"]), "embeddedContent": Schema.Array(Schema.Struct({  })) }), [Schema.Record(Schema.String, Schema.Json)])
export type SpaceDescriptionCreate = { readonly "plain": { readonly "value"?: string, readonly "representation"?: string, readonly [x: string]: Schema.Json } }
export const SpaceDescriptionCreate = Schema.Union([Schema.Struct({ "plain": Schema.StructWithRest(Schema.Struct({ "value": Schema.optionalKey(Schema.String.annotate({ "description": "The space description." })), "representation": Schema.optionalKey(Schema.String.annotate({ "description": "Set to 'plain'." })) }), [Schema.Record(Schema.String, Schema.Json)]) }).annotate({ "description": "The description of the new/updated space. Note, only the 'plain' representation\ncan be used for the description when creating or updating a space." })])
export type SpaceSettingsUpdate = { readonly "routeOverrideEnabled"?: boolean, readonly "contentMode"?: "standard" | "compact" | null }
export const SpaceSettingsUpdate = Schema.Struct({ "routeOverrideEnabled": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Defines whether an override for the space home should be used. This is\nused in conjunction with a space theme provided by an app. For\nexample, if this property is set to true, a theme can display a page\nother than the space homepage when users visit the root URL for a\nspace. This property allows apps to provide content-only theming\nwithout overriding the space home." })), "contentMode": Schema.optionalKey(Schema.Union([Schema.Literals(["standard", "compact"]).annotate({ "description": "The content rendering mode for the space. Controls spacing and typography\nin the editor and renderer. Valid values are \"standard\" and \"compact\".\nWhen set to \"compact\", content is rendered more densely with smaller\nspacing and typography." }), Schema.Union([Schema.Null]).annotate({ "description": "The content rendering mode for the space. Controls spacing and typography\nin the editor and renderer. Valid values are \"standard\" and \"compact\".\nWhen set to \"compact\", content is rendered more densely with smaller\nspacing and typography." })])) })
export type SuperBatchWebResources = { readonly "uris"?: { readonly "all"?: ReadonlyArray<string> | string, readonly "css"?: ReadonlyArray<string> | string, readonly "js"?: ReadonlyArray<string> | string }, readonly "tags"?: { readonly "all"?: string, readonly "css"?: string, readonly "data"?: string, readonly "js"?: string }, readonly "metatags"?: string, readonly "_expandable"?: { readonly [x: string]: Schema.Json } }
export const SuperBatchWebResources = Schema.Struct({ "uris": Schema.optionalKey(Schema.Struct({ "all": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String], { mode: "oneOf" })), "css": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String], { mode: "oneOf" })), "js": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String], { mode: "oneOf" })) })), "tags": Schema.optionalKey(Schema.Struct({ "all": Schema.optionalKey(Schema.String), "css": Schema.optionalKey(Schema.String), "data": Schema.optionalKey(Schema.String), "js": Schema.optionalKey(Schema.String) })), "metatags": Schema.optionalKey(Schema.String), "_expandable": Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)) })
export type SystemInfoEntity = { readonly "cloudId": string, readonly "commitHash": string, readonly "baseUrl"?: string, readonly "fallbackBaseUrl"?: string, readonly "edition"?: string, readonly "siteTitle"?: string, readonly "defaultLocale"?: string, readonly "defaultTimeZone"?: string, readonly "microsPerimeter"?: string }
export const SystemInfoEntity = Schema.Union([Schema.Struct({ "cloudId": Schema.String, "commitHash": Schema.String, "baseUrl": Schema.optionalKey(Schema.String), "fallbackBaseUrl": Schema.optionalKey(Schema.String), "edition": Schema.optionalKey(Schema.String), "siteTitle": Schema.optionalKey(Schema.String), "defaultLocale": Schema.optionalKey(Schema.String), "defaultTimeZone": Schema.optionalKey(Schema.String), "microsPerimeter": Schema.optionalKey(Schema.String) })])
export type ThemeUpdate = { readonly "themeKey": string }
export const ThemeUpdate = Schema.Struct({ "themeKey": Schema.String.annotate({ "description": "The key of the theme to be set as the space theme." }) })
export type UserDetails = { readonly "business"?: { readonly "position"?: string, readonly "department"?: string, readonly "location"?: string }, readonly "personal"?: { readonly "phone"?: string, readonly "im"?: string, readonly "website"?: string, readonly "email"?: string } }
export const UserDetails = Schema.Struct({ "business": Schema.optionalKey(Schema.Struct({ "position": Schema.optionalKey(Schema.String.annotate({ "description": "This property has been deprecated due to privacy changes. There is no replacement. See the\n[migration guide](https://developer.atlassian.com/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/)\nfor details." })), "department": Schema.optionalKey(Schema.String.annotate({ "description": "This property has been deprecated due to privacy changes. There is no replacement. See the\n[migration guide](https://developer.atlassian.com/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/)\nfor details." })), "location": Schema.optionalKey(Schema.String.annotate({ "description": "This property has been deprecated due to privacy changes. There is no replacement. See the\n[migration guide](https://developer.atlassian.com/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/)\nfor details." })) })), "personal": Schema.optionalKey(Schema.Struct({ "phone": Schema.optionalKey(Schema.String.annotate({ "description": "This property has been deprecated due to privacy changes. There is no replacement. See the\n[migration guide](https://developer.atlassian.com/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/)\nfor details." })), "im": Schema.optionalKey(Schema.String.annotate({ "description": "This property has been deprecated due to privacy changes. There is no replacement. See the\n[migration guide](https://developer.atlassian.com/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/)\nfor details." })), "website": Schema.optionalKey(Schema.String.annotate({ "description": "This property has been deprecated due to privacy changes. There is no replacement. See the\n[migration guide](https://developer.atlassian.com/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/)\nfor details." })), "email": Schema.optionalKey(Schema.String.annotate({ "description": "This property has been deprecated due to privacy changes. Use the `User.email` property instead. See the\n[migration guide](https://developer.atlassian.com/cloud/confluence/deprecation-notice-user-privacy-api-migration-guide/)\nfor details." })) })) })
export type UserPropertyCreate = { readonly "value": { readonly [x: string]: Schema.Json } }
export const UserPropertyCreate = Schema.Struct({ "value": Schema.Record(Schema.String, Schema.Json).annotate({ "description": "The value of the user property." }) })
export type UserPropertyUpdate = { readonly "value": { readonly [x: string]: Schema.Json } }
export const UserPropertyUpdate = Schema.Struct({ "value": Schema.Record(Schema.String, Schema.Json).annotate({ "description": "The value of the user property." }) })
export type UserWatch = { readonly "watching": boolean }
export const UserWatch = Schema.Struct({ "watching": Schema.Boolean })
export type VersionRestore = { readonly "operationKey": "restore", readonly "params": { readonly "versionNumber": number, readonly "message": string, readonly "restoreTitle"?: boolean } }
export const VersionRestore = Schema.Struct({ "operationKey": Schema.Literal("restore").annotate({ "description": "Set to 'restore'." }), "params": Schema.Struct({ "versionNumber": Schema.Number.annotate({ "description": "The version number to be restored.", "format": "int32" }).check(Schema.isInt()), "message": Schema.String.annotate({ "description": "Description for the version." }), "restoreTitle": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If true, the content title will be the same as the title from the version restored. Defaults to `false`." })) }) })
export type PermissionSubject = { readonly "type": "user" | "group", readonly "identifier": string }
export const PermissionSubject = Schema.Struct({ "type": Schema.Literals(["user", "group"]), "identifier": Schema.String.annotate({ "description": "for `type=user`, identifier should be user's accountId or `anonymous` for anonymous users\n\nfor `type=group`, identifier should be the groupId." }) }).annotate({ "description": "The user or group that the permission applies to." })
export type PermissionSubjectWithGroupId = { readonly "type": "user" | "group", readonly "identifier": string }
export const PermissionSubjectWithGroupId = Schema.Struct({ "type": Schema.Literals(["user", "group"]), "identifier": Schema.String.annotate({ "description": "for `type=user`, identifier should be user's accountId or `anonymous` for anonymous users\n\nfor `type=group`, identifier should be ID of the group" }) }).annotate({ "description": "The user or group that the permission applies to." })
export type AccountIdEmailRecordArray = ReadonlyArray<AccountIdEmailRecord>
export const AccountIdEmailRecordArray = Schema.Array(AccountIdEmailRecord)
export type AsyncIdArray = ReadonlyArray<AsyncId>
export const AsyncIdArray = Schema.Array(AsyncId)
export type SearchResult = { readonly "content"?: Content, readonly "user"?: User, readonly "space"?: Space, readonly "title": string, readonly "excerpt": string, readonly "url": string, readonly "resultParentContainer"?: ContainerSummary, readonly "resultGlobalContainer"?: ContainerSummary, readonly "breadcrumbs": ReadonlyArray<Breadcrumb>, readonly "entityType": string, readonly "iconCssClass": string, readonly "lastModified": string, readonly "friendlyLastModified"?: string, readonly "score"?: number }
export const SearchResult = Schema.Struct({ "content": Schema.optionalKey(Content), "user": Schema.optionalKey(User), "space": Schema.optionalKey(Space), "title": Schema.String, "excerpt": Schema.String, "url": Schema.String, "resultParentContainer": Schema.optionalKey(ContainerSummary), "resultGlobalContainer": Schema.optionalKey(ContainerSummary), "breadcrumbs": Schema.Array(Breadcrumb), "entityType": Schema.String, "iconCssClass": Schema.String, "lastModified": Schema.String.annotate({ "format": "date-time" }), "friendlyLastModified": Schema.optionalKey(Schema.String), "score": Schema.optionalKey(Schema.Number.check(Schema.isFinite())) })
export type ContentTemplateBodyCreate = { readonly "view"?: ContentBodyCreate, readonly "export_view"?: ContentBodyCreate, readonly "styled_view"?: ContentBodyCreate, readonly "storage"?: ContentBodyCreate, readonly "editor"?: ContentBodyCreate, readonly "editor2"?: ContentBodyCreate, readonly "wiki"?: ContentBodyCreate, readonly "atlas_doc_format"?: ContentBodyCreate, readonly "anonymous_export_view"?: ContentBodyCreate }
export const ContentTemplateBodyCreate = Schema.Struct({ "view": Schema.optionalKey(ContentBodyCreate), "export_view": Schema.optionalKey(ContentBodyCreate), "styled_view": Schema.optionalKey(ContentBodyCreate), "storage": Schema.optionalKey(ContentBodyCreate), "editor": Schema.optionalKey(ContentBodyCreate), "editor2": Schema.optionalKey(ContentBodyCreate), "wiki": Schema.optionalKey(ContentBodyCreate), "atlas_doc_format": Schema.optionalKey(ContentBodyCreate), "anonymous_export_view": Schema.optionalKey(ContentBodyCreate) }).annotate({ "description": "The body of the new content. Does not apply to attachments.\nOnly one body format should be specified as the property for\nthis object, e.g. `storage`.\n\nNote, `editor2` format is used by Atlassian only. `anonymous_export_view` is\nthe same as `export_view` format but only content viewable by an anonymous\nuser is included." })
export type ContentBodyConversionInput = { readonly "to": string, readonly "allowCache"?: boolean, readonly "spaceKeyContext"?: string, readonly "contentIdContext"?: string, readonly "embeddedContentRender"?: "current" | "version-at-save", readonly "expand"?: ReadonlyArray<string>, readonly "body": ContentBodyCreate }
export const ContentBodyConversionInput = Schema.Struct({ "to": Schema.String.annotate({ "description": "The name of the target format for the content body conversion." }), "allowCache": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Controls whether conversion results are cached and reused for identical requests.\n\n- `false`: Each request creates a new conversion task, even if an identical request was made previously.\n- `true`: Enables caching behavior for identical requests from the same user.\n  - If no cached result exists, a new conversion task is created\n  - If a cached result exists, the existing task is marked as RERUNNING and will complete with status COMPLETED\n  - Returns the same task ID for identical requests, allowing you to retrieve the cached result" })), "spaceKeyContext": Schema.optionalKey(Schema.String.annotate({ "description": "The space key used for resolving embedded content (page includes, files, and links) in the content body. For example, if the source content contains the link `<ac:link><ri:page ri:content-title=\"Example page\" /><ac:link>` and the `spaceKeyContext=TEST` parameter is provided, then the link will be converted into a link to the \"Example page\" page in the \"TEST\" space." })), "contentIdContext": Schema.optionalKey(Schema.String.annotate({ "description": "The content ID used to find the space for resolving embedded content (page includes, files, and links) in the content body. For example, if the source content contains the link `<ac:link><ri:page ri:content-title=\"Example page\" /><ac:link>` and the `contentIdContext=123` parameter is provided, then the link will be converted into a link to the \"Example page\" page in the same space that has the content with ID=123. Note that `spaceKeyContext` will be ignored if this parameter is provided." })), "embeddedContentRender": Schema.optionalKey(Schema.Literals(["current", "version-at-save"]).annotate({ "description": "Mode used for rendering embedded content, such as attachments. - `current` renders the embedded content using the latest version. - `version-at-save` renders the embedded content using the version at the time of save." })), "expand": Schema.optionalKey(Schema.Array(Schema.String).annotate({ "description": "A multi-value, comma-separated parameter indicating which properties of the content to expand and populate. Expands are dependent\non the `to` conversion format and may be irrelevant for certain conversions (e.g. `macroRenderedOutput` is redundant when\nconverting to `view` format). \n\nIf rendering to `view` format, and the body content being converted includes arbitrary nested content (such as macros); then it is \nnecessary to include webresource expands in the request. Webresources for content body are the batched JS and CSS dependencies for\nany nested dynamic content (i.e. macros).\n\n- `embeddedContent` returns metadata for nested content (e.g. page included using page include macro)\n- `mediaToken` returns JWT token for retrieving attachment data from Media API\n- `macroRenderedOutput` additionally converts body to view format\n- `webresource.superbatch.uris.js` returns all common JS dependencies as static URLs\n- `webresource.superbatch.uris.css` returns all common CSS dependencies as static URLs\n- `webresource.superbatch.uris.all` returns all common dependencies as static URLs\n- `webresource.superbatch.tags.all` returns all common JS dependencies as html `<script>` tags\n- `webresource.superbatch.tags.css` returns all common CSS dependencies as html `<style>` tags\n- `webresource.superbatch.tags.js` returns all common dependencies as html `<script>` and `<style>` tags\n- `webresource.uris.js` returns JS dependencies specific to conversion\n- `webresource.uris.css` returns CSS dependencies specific to conversion\n- `webresource.uris.all` returns all dependencies specific to conversion     \n- `webresource.tags.all` returns common JS dependencies as html `<script>` tags\n- `webresource.tags.css` returns common CSS dependencies as html `<style>` tags\n- `webresource.tags.js` returns common dependencies as html `<script>` and `<style>` tags" })), "body": ContentBodyCreate })
export type AvailableContentStates = { readonly "spaceContentStates": ReadonlyArray<ContentState>, readonly "customContentStates": ReadonlyArray<ContentState> }
export const AvailableContentStates = Schema.Struct({ "spaceContentStates": Schema.Array(ContentState).annotate({ "description": "Space suggested content states that can be used in the space.\nThis list can be empty if there are no space content states defined in the space or if space content states are disabled in the space.\nAll spaces start with 4 default space content states, and this can be modified in the UI under space settings." }), "customContentStates": Schema.Array(ContentState).annotate({ "description": "Custom content states that can be used by the user on the content of this call.\nThis list can be empty if there are no custom content states defined by the user or if custom content states are disabled in the space of the content.\nThis will at most have 3 of the most recently published content states. \nOnly the calling user has access to place these states on content, but all users can see these states once they are placed." }) })
export type ContentStateSettings = { readonly "contentStatesAllowed": boolean, readonly "customContentStatesAllowed": boolean, readonly "spaceContentStatesAllowed": boolean, readonly "spaceContentStates"?: ReadonlyArray<ContentState> }
export const ContentStateSettings = Schema.Struct({ "contentStatesAllowed": Schema.Boolean.annotate({ "description": "Whether users can place any content states on content" }), "customContentStatesAllowed": Schema.Boolean.annotate({ "description": "Whether users can place their custom states on content" }), "spaceContentStatesAllowed": Schema.Boolean.annotate({ "description": "Whether users can place space suggested states on content" }), "spaceContentStates": Schema.optionalKey(Schema.Array(ContentState).annotate({ "description": "space suggested content states that users can choose from" })) })
export type CopyPageHierarchyRequest = { readonly "copyAttachments"?: boolean, readonly "copyPermissions"?: boolean, readonly "copyProperties"?: boolean, readonly "copyLabels"?: boolean, readonly "copyCustomContents"?: boolean, readonly "copyDescendants"?: boolean, readonly "destinationPageId": ContentId, readonly "titleOptions"?: CopyPageHierarchyTitleOptions }
export const CopyPageHierarchyRequest = Schema.Struct({ "copyAttachments": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, attachments are copied to the destination page." })), "copyPermissions": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, page permissions are copied to the destination page." })), "copyProperties": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, content properties are copied to the destination page." })), "copyLabels": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, labels are copied to the destination page." })), "copyCustomContents": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, custom contents are copied to the destination page." })), "copyDescendants": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, descendants are copied to the destination page." })), "destinationPageId": ContentId, "titleOptions": Schema.optionalKey(CopyPageHierarchyTitleOptions) })
export type CopyPageRequest = { readonly "copyAttachments"?: boolean, readonly "copyPermissions"?: boolean, readonly "copyProperties"?: boolean, readonly "copyLabels"?: boolean, readonly "copyCustomContents"?: boolean, readonly "destination": CopyPageRequestDestination, readonly "pageTitle"?: string, readonly "body"?: { readonly "storage"?: ContentBodyCreate, readonly "editor2"?: ContentBodyCreate } }
export const CopyPageRequest = Schema.Struct({ "copyAttachments": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, attachments are copied to the destination page." })), "copyPermissions": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, page permissions are copied to the destination page." })), "copyProperties": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, content properties are copied to the destination page." })), "copyLabels": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, labels are copied to the destination page." })), "copyCustomContents": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to `true`, custom contents are copied to the destination page." })), "destination": CopyPageRequestDestination, "pageTitle": Schema.optionalKey(Schema.String.annotate({ "description": "If defined, this will replace the title of the destination page." })), "body": Schema.optionalKey(Schema.Struct({ "storage": Schema.optionalKey(ContentBodyCreate), "editor2": Schema.optionalKey(ContentBodyCreate) }).annotate({ "description": "If defined, this will replace the body of the destination page." })) })
export type EmbeddedContent = { readonly "entityId"?: number, readonly "entityType"?: string, readonly "entity"?: Embeddable, readonly [x: string]: Schema.Json }
export const EmbeddedContent = Schema.StructWithRest(Schema.Struct({ "entityId": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "entityType": Schema.optionalKey(Schema.String), "entity": Schema.optionalKey(Embeddable) }), [Schema.Record(Schema.String, Schema.Json)])
export type ContentArray = { readonly "results": ReadonlyArray<Content>, readonly "start"?: number, readonly "limit"?: number, readonly "size": number, readonly "_links": GenericLinks }
export const ContentArray = Schema.Struct({ "results": Schema.Array(Content), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
export type ContentProperty = { readonly "id": string, readonly "key": string, readonly "value": ReadonlyArray<string> | boolean | { readonly [x: string]: Schema.Json } | string, readonly "version"?: { readonly "when": string, readonly "message": string, readonly "number": number, readonly "minorEdit": boolean, readonly "contentTypeModified"?: boolean, readonly [x: string]: Schema.Json }, readonly "_links": GenericLinks, readonly "_expandable"?: { readonly "content"?: string, readonly "additionalProperties"?: string }, readonly [x: string]: Schema.Json }
export const ContentProperty = Schema.StructWithRest(Schema.Struct({ "id": Schema.String, "key": Schema.String, "value": Schema.Union([Schema.Array(Schema.String), Schema.Boolean, Schema.Record(Schema.String, Schema.Json), Schema.String], { mode: "oneOf" }).annotate({ "description": "The value of the content property. This can be empty or a complex object." }), "version": Schema.optionalKey(Schema.StructWithRest(Schema.Struct({ "when": Schema.String.annotate({ "format": "date-time" }), "message": Schema.String, "number": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "minorEdit": Schema.Boolean, "contentTypeModified": Schema.optionalKey(Schema.Boolean.annotate({ "description": "True if content type is modifed in this version (e.g. page to blog)" })) }), [Schema.Record(Schema.String, Schema.Json)])), "_links": GenericLinks, "_expandable": Schema.optionalKey(Schema.Struct({ "content": Schema.optionalKey(Schema.String), "additionalProperties": Schema.optionalKey(Schema.String) })) }), [Schema.Record(Schema.String, Schema.Json)])
export type Group = { readonly "type": "group", readonly "name": string, readonly "id": string, readonly "usageType"?: "USERBASE_GROUP" | "TEAM_COLLABORATION", readonly "managedBy"?: "ADMINS" | "EXTERNAL" | "TEAM_MEMBERS" | "OPEN", readonly "_links"?: GenericLinks }
export const Group = Schema.Struct({ "type": Schema.Literal("group"), "name": Schema.String, "id": Schema.String, "usageType": Schema.optionalKey(Schema.Literals(["USERBASE_GROUP", "TEAM_COLLABORATION"]).annotate({ "description": "This property represents how this collection of users is used:\n  - `USERBASE_GROUP`: This value indicates that the collection of users is used as a group.\n  - `TEAM_COLLABORATION`: This value indicates that the collection of users is used as a team." })), "managedBy": Schema.optionalKey(Schema.Literals(["ADMINS", "EXTERNAL", "TEAM_MEMBERS", "OPEN"]).annotate({ "description": "This property represents how this collection of users is managed:\n  - `ADMINS`: This value indicates that the collection of users is managed by org, site or product admins.\n  - `EXTERNAL`: This value indicates that the collection of users is managed externally (through SCIM, HRIS, etc.).\n  - `TEAM_MEMBERS`: This value indicates that the collection of users is managed by its members.\n  - `OPEN`: This value indicates that the collection of users is not actively managed by any users." })), "_links": Schema.optionalKey(GenericLinks) })
export type MacroInstance = { readonly "name"?: string, readonly "body"?: string, readonly "parameters"?: {  }, readonly "_links"?: GenericLinks }
export const MacroInstance = Schema.Struct({ "name": Schema.optionalKey(Schema.String), "body": Schema.optionalKey(Schema.String), "parameters": Schema.optionalKey(Schema.Struct({  })), "_links": Schema.optionalKey(GenericLinks) })
export type SpaceSettings = { readonly "routeOverrideEnabled": boolean, readonly "editor"?: { readonly "page": string, readonly "blogpost": string, readonly "default": string }, readonly "contentMode"?: "standard" | "compact" | null, readonly "spaceKey"?: string, readonly "_links": GenericLinks }
export const SpaceSettings = Schema.Union([Schema.Struct({ "routeOverrideEnabled": Schema.Boolean.annotate({ "description": "Defines whether an override for the space home should be used. This is\nused in conjunction with a space theme provided by an app. For\nexample, if this property is set to true, a theme can display a page\nother than the space homepage when users visit the root URL for a\nspace. This property allows apps to provide content-only theming\nwithout overriding the space home." }), "editor": Schema.optionalKey(Schema.Struct({ "page": Schema.String, "blogpost": Schema.String, "default": Schema.String })), "contentMode": Schema.optionalKey(Schema.Union([Schema.Literals(["standard", "compact"]).annotate({ "description": "The content rendering mode for the space. Controls spacing and typography\nin the editor and renderer. Valid values are \"standard\" and \"compact\".\nWhen set to \"compact\", content is rendered more densely with smaller\nspacing and typography." }), Schema.Union([Schema.Null]).annotate({ "description": "The content rendering mode for the space. Controls spacing and typography\nin the editor and renderer. Valid values are \"standard\" and \"compact\".\nWhen set to \"compact\", content is rendered more densely with smaller\nspacing and typography." })])), "spaceKey": Schema.optionalKey(Schema.String), "_links": GenericLinks })])
export type Task = { readonly "globalId": number, readonly "id": number, readonly "contentId": number, readonly "status": string, readonly "title"?: string, readonly "description"?: string, readonly "body"?: string, readonly "creator": string, readonly "assignee"?: string, readonly "completeUser"?: string, readonly "createDate": number, readonly "dueDate"?: number, readonly "updateDate"?: number, readonly "completeDate"?: number, readonly "_links"?: GenericLinks }
export const Task = Schema.Struct({ "globalId": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()), "id": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()), "contentId": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()), "status": Schema.String, "title": Schema.optionalKey(Schema.String), "description": Schema.optionalKey(Schema.String), "body": Schema.optionalKey(Schema.String), "creator": Schema.String, "assignee": Schema.optionalKey(Schema.String), "completeUser": Schema.optionalKey(Schema.String), "createDate": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()), "dueDate": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "updateDate": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "completeDate": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "_links": Schema.optionalKey(GenericLinks) })
export type UserArray = { readonly "results": ReadonlyArray<User>, readonly "start"?: number, readonly "limit"?: number, readonly "size"?: number, readonly "totalSize"?: number, readonly "_links"?: GenericLinks }
export const UserArray = Schema.Struct({ "results": Schema.Array(User), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "size": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "totalSize": Schema.optionalKey(Schema.Number.annotate({ "description": "This property will return total count of the objects before pagination is applied.\nThis value is returned if `shouldReturnTotalSize` is set to `true`.", "format": "int64" }).check(Schema.isInt())), "_links": Schema.optionalKey(GenericLinks) })
export type UserProperty = { readonly "key": string, readonly "value": { readonly [x: string]: Schema.Json }, readonly "id": string, readonly "lastModifiedDate": string, readonly "createdDate": string, readonly "_links"?: GenericLinks }
export const UserProperty = Schema.Struct({ "key": Schema.String, "value": Schema.Record(Schema.String, Schema.Json).annotate({ "description": "The value of the content property." }), "id": Schema.String.annotate({ "description": "a unique identifier for the user property" }), "lastModifiedDate": Schema.String.annotate({ "description": "datetime when the property was last modified such as `2022-02-01T12:00:00.111Z`", "format": "date-time" }), "createdDate": Schema.String.annotate({ "description": "datetime when the property was created such as `2022-01-01T12:00:00.111Z`", "format": "date-time" }), "_links": Schema.optionalKey(GenericLinks) })
export type UserPropertyKeyArray = { readonly "results": ReadonlyArray<{ readonly "key"?: string }>, readonly "start"?: number, readonly "limit"?: number, readonly "size"?: number, readonly "_links"?: GenericLinks }
export const UserPropertyKeyArray = Schema.Struct({ "results": Schema.Array(Schema.Struct({ "key": Schema.optionalKey(Schema.String) })), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "size": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "_links": Schema.optionalKey(GenericLinks) })
export type UsersUserKeys = { readonly "users"?: ReadonlyArray<User>, readonly "userKeys"?: ReadonlyArray<string>, readonly "_links"?: GenericLinks, readonly "userAccountIds": Schema.Json }
export const UsersUserKeys = Schema.Union([Schema.Struct({ "users": Schema.optionalKey(Schema.Array(User)), "userKeys": Schema.optionalKey(Schema.Array(Schema.String)), "_links": Schema.optionalKey(GenericLinks), "userAccountIds": Schema.Json })])
export type AuditRecord = { readonly "author": { readonly "type": "user", readonly "displayName": string, readonly "operations"?: ReadonlyArray<{ readonly "operation": "administer" | "archive" | "clear_permissions" | "copy" | "create" | "create_space" | "delete" | "export" | "move" | "purge" | "purge_version" | "read" | "restore" | "restrict_content" | "update" | "use", readonly "targetType": string }>, readonly "username"?: GenericUserName, readonly "userKey"?: GenericUserKey, readonly "accountId"?: GenericAccountId, readonly "accountType"?: string, readonly "externalCollaborator"?: boolean, readonly "isExternalCollaborator"?: boolean, readonly "isGuest"?: boolean, readonly "publicName"?: string }, readonly "remoteAddress": string, readonly "creationDate": number, readonly "summary": string, readonly "description": string, readonly "category": string, readonly "sysAdmin": boolean, readonly "superAdmin"?: boolean, readonly "affectedObject": AffectedObject, readonly "changedValues": ReadonlyArray<ChangedValue>, readonly "associatedObjects": ReadonlyArray<AffectedObject> }
export const AuditRecord = Schema.Struct({ "author": Schema.Struct({ "type": Schema.Literal("user"), "displayName": Schema.String, "operations": Schema.optionalKey(Schema.Union([Schema.Array(Schema.Struct({ "operation": Schema.Literals(["administer", "archive", "clear_permissions", "copy", "create", "create_space", "delete", "export", "move", "purge", "purge_version", "read", "restore", "restrict_content", "update", "use"]).annotate({ "description": "The operation itself." }), "targetType": Schema.String.annotate({ "description": "The space or content type that the operation applies to. Could be one of- - application - page - blogpost - comment - attachment - space" }) }).annotate({ "description": "An operation and the target entity that it applies to, e.g. create page." }))])), "username": Schema.optionalKey(GenericUserName), "userKey": Schema.optionalKey(GenericUserKey), "accountId": Schema.optionalKey(GenericAccountId), "accountType": Schema.optionalKey(Schema.String), "externalCollaborator": Schema.optionalKey(Schema.Boolean.annotate({ "description": "This is deprecated. Use `isGuest` instead." })), "isExternalCollaborator": Schema.optionalKey(Schema.Boolean.annotate({ "description": "This is deprecated. Use `isGuest` instead. Whether the user is an external collaborator user" })), "isGuest": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the user is a guest user" })), "publicName": Schema.optionalKey(Schema.String.annotate({ "description": "The public name or nickname of the user. Will always contain a value." })) }), "remoteAddress": Schema.String, "creationDate": Schema.Number.annotate({ "description": "The creation date-time of the audit record, as a timestamp.", "format": "int64" }).check(Schema.isInt()), "summary": Schema.String, "description": Schema.String, "category": Schema.String, "sysAdmin": Schema.Boolean, "superAdmin": Schema.optionalKey(Schema.Boolean), "affectedObject": AffectedObject, "changedValues": Schema.Array(ChangedValue), "associatedObjects": Schema.Array(AffectedObject) })
export type AddContentRestriction = { readonly "operation": "read" | "update", readonly "restrictions": { readonly "user"?: ReadonlyArray<{ readonly "type": "known" | "unknown" | "anonymous" | "user", readonly "username"?: GenericUserName, readonly "userKey"?: GenericUserKey, readonly "accountId": GenericAccountId }>, readonly "group"?: ReadonlyArray<{ readonly "type": "group", readonly "name": string }> } }
export const AddContentRestriction = Schema.Struct({ "operation": Schema.Literals(["read", "update"]).annotate({ "description": "The restriction operation applied to content." }), "restrictions": Schema.Struct({ "user": Schema.optionalKey(Schema.Array(Schema.Struct({ "type": Schema.Literals(["known", "unknown", "anonymous", "user"]).annotate({ "description": "Set to 'known'." }), "username": Schema.optionalKey(GenericUserName), "userKey": Schema.optionalKey(GenericUserKey), "accountId": GenericAccountId }).annotate({ "description": "A user that the restriction will be applied to. Either the `username`\nor the `userKey` must be specified to identify the user." })).annotate({ "description": "The users that the restrictions will be applied to. This array must\nhave at least one item, otherwise it should be omitted." })), "group": Schema.optionalKey(Schema.Array(Schema.Struct({ "type": Schema.Literal("group").annotate({ "description": "Set to 'group'." }), "name": Schema.String.annotate({ "description": "The name of the group." }) }).annotate({ "description": "A group that the restriction will be applied to." })).annotate({ "description": "The groups that the restrictions will be applied to. This array must\nhave at least one item, otherwise it should be omitted." })) }).annotate({ "description": "The users/groups that the restrictions will be applied to. At least one of\n`user` or `group` must be specified for this object." }) })
export type Theme = { readonly "themeKey": string, readonly "name"?: string, readonly "description"?: string, readonly "icon"?: Icon, readonly "_links"?: GenericLinks }
export const Theme = Schema.Struct({ "themeKey": Schema.String, "name": Schema.optionalKey(Schema.String), "description": Schema.optionalKey(Schema.String), "icon": Schema.optionalKey(Icon), "_links": Schema.optionalKey(GenericLinks) })
export type ThemeNoLinks = { readonly "themeKey": string, readonly "name"?: string, readonly "description"?: string, readonly "icon"?: Icon }
export const ThemeNoLinks = Schema.Struct({ "themeKey": Schema.String, "name": Schema.optionalKey(Schema.String), "description": Schema.optionalKey(Schema.String), "icon": Schema.optionalKey(Icon) }).annotate({ "description": "Theme object without links. Used in ThemeArray." })
export type LabelArray = { readonly "results": ReadonlyArray<Label>, readonly "start"?: number, readonly "limit"?: number, readonly "size": number, readonly "_links"?: GenericLinks }
export const LabelArray = Schema.Struct({ "results": Schema.Array(Label), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": Schema.optionalKey(GenericLinks) })
export type LabeledContent = { readonly "contentType": LabeledContentType, readonly "contentId": number, readonly "title": string }
export const LabeledContent = Schema.Struct({ "contentType": LabeledContentType, "contentId": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()), "title": Schema.String.annotate({ "description": "Title of the content." }) })
export type LabelCreateArray = ReadonlyArray<LabelCreate>
export const LabelCreateArray = Schema.Array(LabelCreate)
export type LongTaskStatus = { readonly "ari"?: string, readonly "id": string, readonly "name": { readonly "key": string, readonly "args": ReadonlyArray<{  }> }, readonly "elapsedTime": number, readonly "percentageComplete": number, readonly "successful": boolean, readonly "finished": boolean, readonly "messages": ReadonlyArray<Message>, readonly "status"?: string, readonly "errors"?: ReadonlyArray<Message>, readonly "additionalDetails"?: { readonly "destinationId"?: string, readonly "destinationUrl"?: string, readonly "totalPageNeedToCopy"?: number, readonly "additionalProperties"?: string } }
export const LongTaskStatus = Schema.Struct({ "ari": Schema.optionalKey(Schema.String.annotate({ "description": "the ARI for the long task, based on its ID" })), "id": Schema.String, "name": Schema.Struct({ "key": Schema.String, "args": Schema.Array(Schema.Struct({  })) }), "elapsedTime": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()), "percentageComplete": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "successful": Schema.Boolean, "finished": Schema.Boolean, "messages": Schema.Array(Message), "status": Schema.optionalKey(Schema.String), "errors": Schema.optionalKey(Schema.Array(Message)), "additionalDetails": Schema.optionalKey(Schema.Struct({ "destinationId": Schema.optionalKey(Schema.String), "destinationUrl": Schema.optionalKey(Schema.String), "totalPageNeedToCopy": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "additionalProperties": Schema.optionalKey(Schema.String) })) }).annotate({ "description": "Current status of a long running task\n\nStatus keys:\n\n- `ERROR_UNKNOWN` - Generic error\n- `ERROR_LOCK_FAILED` - Could not get the lock on destination space\n- `ERROR_RELINK` - Error when relink pages/attachments\n- `ERROR_COPY_PAGE` - Error while copying 1 page\n- `WARN_RENAME_PAGE` - Warning page is rename during copy\n- `WARN_IGNORE_COPY_PERMISSION` - Warning could not copy permission\n- `WARN_IGNORE_COPY_ATTACHMENT` - Warning could not copy attachment\n- `WARN_IGNORE_DELETE_PAGE` - Warning ignoring delete of a non agreed on page\n- `STATUS_COPIED_PAGES` - Message total pages are copied\n- `STATUS_COPYING_PAGES` - Message copy pages\n- `STATUS_RELINK_PAGES` - Message relink pages/attachments\n- `STATUS_DELETING_PAGES` - Message delete pages\n- `STATUS_DELETED_PAGES` - Message total pages are deleted\n- `STATUS_MOVING_PAGES` - Message move pages\n- `WARN_IGNORE_VIEW_RESTRICTED` - Permission changed - view restricted\n- `WARN_IGNORE_EDIT_RESTRICTED` - Permission changed - edit restricted\n- `INITIALIZING_TASK` - Message when initializing task\n- `UNKNOWN_STATUS` - Message when status is unknown" })
export type LongTaskStatusWithLinks = { readonly "ari"?: string, readonly "id": string, readonly "name": { readonly "key": string, readonly "args": ReadonlyArray<{  }> }, readonly "elapsedTime": number, readonly "percentageComplete": number, readonly "successful": boolean, readonly "finished": boolean, readonly "messages": ReadonlyArray<Message>, readonly "_links": GenericLinks, readonly "status"?: string, readonly "errors"?: ReadonlyArray<Message>, readonly "additionalDetails"?: { readonly "destinationId"?: string | null, readonly "destinationUrl"?: string, readonly "totalPageNeedToCopy"?: number, readonly "additionalProperties"?: string } }
export const LongTaskStatusWithLinks = Schema.Struct({ "ari": Schema.optionalKey(Schema.String.annotate({ "description": "the ARI for the long task, based on its ID" })), "id": Schema.String, "name": Schema.Struct({ "key": Schema.String, "args": Schema.Array(Schema.Struct({  })) }), "elapsedTime": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()), "percentageComplete": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "successful": Schema.Boolean, "finished": Schema.Boolean, "messages": Schema.Array(Message), "_links": GenericLinks, "status": Schema.optionalKey(Schema.String), "errors": Schema.optionalKey(Schema.Array(Message)), "additionalDetails": Schema.optionalKey(Schema.Struct({ "destinationId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "destinationUrl": Schema.optionalKey(Schema.String), "totalPageNeedToCopy": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "additionalProperties": Schema.optionalKey(Schema.String) })) }).annotate({ "description": "Same as LongTaskStatus but with `_links` property.\n\nStatus keys:\n\n- `ERROR_UNKNOWN` - Generic error\n- `ERROR_LOCK_FAILED` - Could not get the lock on destination space\n- `ERROR_RELINK` - Error when relink pages/attachments\n- `ERROR_COPY_PAGE` - Error while copying 1 page\n- `WARN_RENAME_PAGE` - Warning page is rename during copy\n- `WARN_IGNORE_COPY_PERMISSION` - Warning could not copy permission\n- `WARN_IGNORE_COPY_ATTACHMENT` - Warning could not copy attachment\n- `WARN_IGNORE_DELETE_PAGE` - Warning ignoring delete of a non agreed on page\n- `STATUS_COPIED_PAGES` - Message total pages are copied\n- `STATUS_COPYING_PAGES` - Message copy pages\n- `STATUS_RELINK_PAGES` - Message relink pages/attachments\n- `STATUS_DELETING_PAGES` - Message delete pages\n- `STATUS_DELETED_PAGES` - Message total pages are deleted\n- `STATUS_MOVING_PAGES` - Message move pages\n- `WARN_IGNORE_VIEW_RESTRICTED` - Permission changed - view restricted\n- `WARN_IGNORE_EDIT_RESTRICTED` - Permission changed - edit restricted\n- `INITIALIZING_TASK` - Message when initializing task\n- `UNKNOWN_STATUS` - Message when status is unknown" })
export type PermissionCheckResponse = { readonly "hasPermission": boolean, readonly "errors"?: ReadonlyArray<Message>, readonly "_links"?: GenericLinks }
export const PermissionCheckResponse = Schema.Struct({ "hasPermission": Schema.Boolean, "errors": Schema.optionalKey(Schema.Array(Message)), "_links": Schema.optionalKey(GenericLinks) }).annotate({ "description": "This object represents the response for the content permission check API. If the user or group does not have\npermissions, the following errors may be returned:\n\n- Group does not have permission to the space\n- Group does not have permission to the content\n- User is not allowed to use Confluence\n- User does not have permission to the space\n- User does not have permission to the content\n- Anonymous users are not allowed to use Confluence\n- Anonymous user does not have permission to the space\n- Anonymous user does not have permission to the content" })
export type AuditRecordCreate = { readonly "author"?: { readonly "type": "user", readonly "displayName"?: string, readonly "operations"?: ReadonlyArray<OperationCheckResult>, readonly "username"?: GenericUserName, readonly "userKey"?: GenericUserKey }, readonly "remoteAddress": string, readonly "creationDate"?: number, readonly "summary"?: string, readonly "description"?: string, readonly "category"?: string, readonly "sysAdmin"?: boolean, readonly "affectedObject"?: AffectedObject, readonly "changedValues"?: ReadonlyArray<ChangedValue>, readonly "associatedObjects"?: ReadonlyArray<AffectedObject> }
export const AuditRecordCreate = Schema.Struct({ "author": Schema.optionalKey(Schema.Struct({ "type": Schema.Literal("user").annotate({ "description": "Set to 'user'." }), "displayName": Schema.optionalKey(Schema.String.annotate({ "description": "The name that is displayed on the audit log in the Confluence UI." })), "operations": Schema.optionalKey(Schema.Array(OperationCheckResult).annotate({ "description": "Always defaults to null." })), "username": Schema.optionalKey(GenericUserName), "userKey": Schema.optionalKey(GenericUserKey) }).annotate({ "description": "The user that actioned the event. If `author` is not specified, then all\n`author` properties will be set to null/empty, except for `type` which\nwill be set to 'user'." })), "remoteAddress": Schema.String.annotate({ "description": "The IP address of the computer where the event was initiated from." }), "creationDate": Schema.optionalKey(Schema.Number.annotate({ "description": "The creation date-time of the audit record, as a timestamp. This is converted\nto a date-time display in the Confluence UI. If the `creationDate` is not\nspecified, then it will be set to the timestamp for the current date-time.", "format": "int64" }).check(Schema.isInt())), "summary": Schema.optionalKey(Schema.String.annotate({ "description": "The summary of the event, which is displayed in the 'Change' column on\nthe audit log in the Confluence UI." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "A long description of the event, which is displayed in the 'Description'\nfield on the audit log in the Confluence UI." })), "category": Schema.optionalKey(Schema.String.annotate({ "description": "The category of the event, which is displayed in the 'Event type' column\non the audit log in the Confluence UI." })), "sysAdmin": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the event was actioned by a system administrator." })), "affectedObject": Schema.optionalKey(AffectedObject), "changedValues": Schema.optionalKey(Schema.Array(ChangedValue).annotate({ "description": "The values that were changed in the event." })), "associatedObjects": Schema.optionalKey(Schema.Array(AffectedObject).annotate({ "description": "Objects that were associated with the event. For example, if the event\nwas a space permission change then the associated object would be the\nspace." })) })
export type UserAnonymous = { readonly "type": string, readonly "profilePicture": Icon, readonly "displayName": string, readonly "operations"?: ReadonlyArray<OperationCheckResult>, readonly "_expandable"?: { readonly "operations"?: string }, readonly "_links": GenericLinks }
export const UserAnonymous = Schema.Struct({ "type": Schema.String, "profilePicture": Icon, "displayName": Schema.String, "operations": Schema.optionalKey(Schema.Array(OperationCheckResult)), "_expandable": Schema.optionalKey(Schema.Struct({ "operations": Schema.optionalKey(Schema.String) })), "_links": GenericLinks })
export type Relation = { readonly "name": string, readonly "relationData"?: RelationData, readonly "source"?: Content | User | Space, readonly "target"?: Content | User | Space, readonly "_expandable"?: { readonly "relationData"?: string, readonly "source"?: string, readonly "target"?: string }, readonly "_links": GenericLinks }
export const Relation = Schema.Struct({ "name": Schema.String, "relationData": Schema.optionalKey(RelationData), "source": Schema.optionalKey(Schema.Union([Content, User, Space], { mode: "oneOf" })), "target": Schema.optionalKey(Schema.Union([Content, User, Space], { mode: "oneOf" })), "_expandable": Schema.optionalKey(Schema.Struct({ "relationData": Schema.optionalKey(Schema.String), "source": Schema.optionalKey(Schema.String), "target": Schema.optionalKey(Schema.String) })), "_links": GenericLinks })
export type ContentLookAndFeel = { readonly "screen"?: ScreenLookAndFeel, readonly "container"?: ContainerLookAndFeel, readonly "header"?: ContainerLookAndFeel, readonly "body"?: ContainerLookAndFeel }
export const ContentLookAndFeel = Schema.Struct({ "screen": Schema.optionalKey(ScreenLookAndFeel), "container": Schema.optionalKey(ContainerLookAndFeel), "header": Schema.optionalKey(ContainerLookAndFeel), "body": Schema.optionalKey(ContainerLookAndFeel) })
export type HeaderLookAndFeel = { readonly "backgroundColor": string, readonly "button": ButtonLookAndFeel, readonly "primaryNavigation": NavigationLookAndFeel, readonly "secondaryNavigation": NavigationLookAndFeel, readonly "search": SearchFieldLookAndFeel }
export const HeaderLookAndFeel = Schema.Struct({ "backgroundColor": Schema.String, "button": ButtonLookAndFeel, "primaryNavigation": NavigationLookAndFeel, "secondaryNavigation": NavigationLookAndFeel, "search": SearchFieldLookAndFeel })
export type HorizontalHeaderLookAndFeel = { readonly "backgroundColor": string, readonly "button"?: ButtonLookAndFeel, readonly "primaryNavigation": TopNavigationLookAndFeel, readonly "secondaryNavigation"?: NavigationLookAndFeel, readonly "search"?: SearchFieldLookAndFeel }
export const HorizontalHeaderLookAndFeel = Schema.Struct({ "backgroundColor": Schema.String, "button": Schema.optionalKey(ButtonLookAndFeel), "primaryNavigation": TopNavigationLookAndFeel, "secondaryNavigation": Schema.optionalKey(NavigationLookAndFeel), "search": Schema.optionalKey(SearchFieldLookAndFeel) })
export type SpaceCreate = { readonly "name": string, readonly "key"?: string, readonly "alias"?: string, readonly "description"?: SpaceDescriptionCreate, readonly "permissions"?: ReadonlyArray<{ readonly "subjects"?: { readonly "user"?: { readonly "results": ReadonlyArray<User>, readonly "size": number }, readonly "group"?: { readonly "results": ReadonlyArray<GroupCreate>, readonly "size": number } }, readonly "operation": OperationCheckResult, readonly "anonymousAccess": boolean, readonly "unlicensedAccess": boolean, readonly [x: string]: Schema.Json }>, readonly [x: string]: Schema.Json }
export const SpaceCreate = Schema.StructWithRest(Schema.Struct({ "name": Schema.String.annotate({ "description": "The name of the new space." }).check(Schema.isMaxLength(200)), "key": Schema.optionalKey(Schema.String.annotate({ "description": "The key for the new space. Format: See [Space\nkeys](https://confluence.atlassian.com/x/lqNMMQ). If `alias` is not provided, this is required." })), "alias": Schema.optionalKey(Schema.String.annotate({ "description": "This field will be used as the new identifier for the space in confluence page URLs.\nIf the property is not provided the alias will be the provided key.\nThis property is experimental and may be changed or removed in the future." })), "description": Schema.optionalKey(SpaceDescriptionCreate), "permissions": Schema.optionalKey(Schema.Union([Schema.Array(Schema.StructWithRest(Schema.Struct({ "subjects": Schema.optionalKey(Schema.Struct({ "user": Schema.optionalKey(Schema.Struct({ "results": Schema.Array(User), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()) })), "group": Schema.optionalKey(Schema.Struct({ "results": Schema.Array(GroupCreate), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()) })) }).annotate({ "description": "The users and/or groups that the permission applies to." })), "operation": OperationCheckResult, "anonymousAccess": Schema.Boolean.annotate({ "description": "Grant anonymous users permission to use the operation." }), "unlicensedAccess": Schema.Boolean.annotate({ "description": "Grants access to unlicensed users from JIRA Service Desk when used\nwith the 'read space' operation." }) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "This object represents a permission for given space. Permissions consist of\nat least one operation object with an accompanying subjects object.\n\nThe following combinations of `operation` and `targetType` values are\nvalid for the `operation` object:\n\n  - 'create': 'page', 'blogpost', 'comment', 'attachment'\n  - 'read': 'space'\n  - 'delete': 'page', 'blogpost', 'comment', 'attachment'\n  - 'export': 'space'\n  - 'administer': 'space'" })).annotate({ "description": "The permissions for the new space. If no permissions are provided, the\n[Confluence default space permissions](https://confluence.atlassian.com/x/UAgzKw#CreateaSpace-Spacepermissions)\nare applied. Note that if permissions are provided, the space is\ncreated with only the provided set of permissions, not\nincluding the default space permissions. Space permissions\ncan be modified after creation using the space permissions\nendpoints, and a private space can be created using the\ncreate private space endpoint." })])) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "This is the request object used when creating a new space." })
export type SpaceUpdate = { readonly "name"?: string, readonly "description"?: SpaceDescriptionCreate, readonly "homepage"?: {  } | null, readonly "type"?: string, readonly "status"?: string | null, readonly [x: string]: Schema.Json }
export const SpaceUpdate = Schema.StructWithRest(Schema.Struct({ "name": Schema.optionalKey(Schema.Union([Schema.String.check(Schema.isMaxLength(200, { "description": "The updated name of the space." }))])), "description": Schema.optionalKey(SpaceDescriptionCreate), "homepage": Schema.optionalKey(Schema.Union([Schema.Struct({  }), Schema.Null]).annotate({ "description": "The updated homepage for this space" })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "The updated type for this space." })), "status": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The updated status for this space." })) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "The properties of a space that can be updated." })
export type WebResourceDependencies = { readonly "_expandable"?: { readonly "uris"?: string | { readonly [x: string]: Schema.Json }, readonly [x: string]: Schema.Json }, readonly "keys"?: ReadonlyArray<string>, readonly "contexts"?: ReadonlyArray<string>, readonly "uris"?: { readonly "all"?: ReadonlyArray<string> | string, readonly "css"?: ReadonlyArray<string> | string, readonly "js"?: ReadonlyArray<string> | string, readonly "_expandable"?: { readonly "css"?: ReadonlyArray<string> | string, readonly "js"?: ReadonlyArray<string> | string, readonly [x: string]: Schema.Json } }, readonly "tags"?: { readonly "all"?: string, readonly "css"?: string, readonly "data"?: string, readonly "js"?: string, readonly "_expandable"?: { readonly [x: string]: Schema.Json } }, readonly "superbatch"?: SuperBatchWebResources }
export const WebResourceDependencies = Schema.Struct({ "_expandable": Schema.optionalKey(Schema.StructWithRest(Schema.Struct({ "uris": Schema.optionalKey(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Json)], { mode: "oneOf" })) }), [Schema.Record(Schema.String, Schema.Json)])), "keys": Schema.optionalKey(Schema.Array(Schema.String)), "contexts": Schema.optionalKey(Schema.Array(Schema.String)), "uris": Schema.optionalKey(Schema.Struct({ "all": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String], { mode: "oneOf" })), "css": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String], { mode: "oneOf" })), "js": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String], { mode: "oneOf" })), "_expandable": Schema.optionalKey(Schema.StructWithRest(Schema.Struct({ "css": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String], { mode: "oneOf" })), "js": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String], { mode: "oneOf" })) }), [Schema.Record(Schema.String, Schema.Json)])) })), "tags": Schema.optionalKey(Schema.Struct({ "all": Schema.optionalKey(Schema.String), "css": Schema.optionalKey(Schema.String), "data": Schema.optionalKey(Schema.String), "js": Schema.optionalKey(Schema.String), "_expandable": Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)) })), "superbatch": Schema.optionalKey(SuperBatchWebResources) })
export type BulkUserLookup = { readonly "type": "known" | "unknown" | "anonymous" | "user", readonly "username"?: GenericUserName, readonly "userKey"?: GenericUserKey, readonly "accountId": GenericAccountId, readonly "accountType": string, readonly "email": string, readonly "publicName": string, readonly "profilePicture": Icon, readonly "displayName": string, readonly "timeZone"?: string | null, readonly "isExternalCollaborator"?: boolean, readonly "isGuest"?: boolean, readonly "operations"?: ReadonlyArray<OperationCheckResult>, readonly "details"?: UserDetails, readonly "personalSpace"?: Space, readonly "_expandable": { readonly "operations"?: string, readonly "details"?: string, readonly "personalSpace"?: string }, readonly "_links": GenericLinks }
export const BulkUserLookup = Schema.Struct({ "type": Schema.Literals(["known", "unknown", "anonymous", "user"]), "username": Schema.optionalKey(GenericUserName), "userKey": Schema.optionalKey(GenericUserKey), "accountId": GenericAccountId, "accountType": Schema.String.annotate({ "description": "The account type of the user, may return empty string if unavailable." }), "email": Schema.String.annotate({ "description": "The email address of the user. Depending on the user's privacy setting, this may return an empty string." }), "publicName": Schema.String.annotate({ "description": "The public name or nickname of the user. Will always contain a value." }), "profilePicture": Icon, "displayName": Schema.String.annotate({ "description": "The displays name of the user. Depending on the user's privacy setting, this may be the same as publicName." }), "timeZone": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "This displays user time zone. Depending on the user's privacy setting, this may return null." })), "isExternalCollaborator": Schema.optionalKey(Schema.Boolean.annotate({ "description": "This is deprecated. Use `isGuest` instead to find out whether the user is a guest user." })), "isGuest": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the user is a guest user" })), "operations": Schema.optionalKey(Schema.Array(OperationCheckResult)), "details": Schema.optionalKey(UserDetails), "personalSpace": Schema.optionalKey(Space), "_expandable": Schema.Struct({ "operations": Schema.optionalKey(Schema.String), "details": Schema.optionalKey(Schema.String), "personalSpace": Schema.optionalKey(Schema.String) }), "_links": GenericLinks })
export type WatchUser = { readonly "type": string, readonly "username"?: GenericUserName, readonly "userKey"?: GenericUserKey, readonly "accountId": GenericAccountId, readonly "profilePicture": Icon, readonly "displayName": string, readonly "timeZone"?: string | null, readonly "operations": ReadonlyArray<{ readonly "operation": "administer" | "archive" | "clear_permissions" | "copy" | "create" | "create_space" | "delete" | "export" | "move" | "purge" | "purge_version" | "read" | "restore" | "restrict_content" | "update" | "use", readonly "targetType": string }>, readonly "externalCollaborator": boolean, readonly "isGuest": boolean | null, readonly "isExternalCollaborator": boolean, readonly "details"?: UserDetails, readonly "accountType": string, readonly "email": string, readonly "publicName": string, readonly "personalSpace": {  } | null }
export const WatchUser = Schema.Struct({ "type": Schema.String, "username": Schema.optionalKey(GenericUserName), "userKey": Schema.optionalKey(GenericUserKey), "accountId": GenericAccountId, "profilePicture": Icon, "displayName": Schema.String, "timeZone": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "operations": Schema.Union([Schema.Array(Schema.Struct({ "operation": Schema.Literals(["administer", "archive", "clear_permissions", "copy", "create", "create_space", "delete", "export", "move", "purge", "purge_version", "read", "restore", "restrict_content", "update", "use"]).annotate({ "description": "The operation itself." }), "targetType": Schema.String.annotate({ "description": "The space or content type that the operation applies to. Could be one of- - application - page - blogpost - comment - attachment - space" }) }).annotate({ "description": "An operation and the target entity that it applies to, e.g. create page." }))]), "externalCollaborator": Schema.Boolean, "isGuest": Schema.Union([Schema.Boolean, Schema.Null]), "isExternalCollaborator": Schema.Boolean, "details": Schema.optionalKey(UserDetails), "accountType": Schema.String, "email": Schema.String, "publicName": Schema.String, "personalSpace": Schema.Union([Schema.Struct({  }), Schema.Null]) }).annotate({ "description": "This essentially the same as the `User` object, but no `_links` property and\nno `_expandable` property (therefore, different required fields)." })
export type SpacePermissionV2 = { readonly "id": number, readonly "subject": PermissionSubject, readonly "operation": { readonly "key": "administer" | "archive" | "copy" | "create" | "delete" | "export" | "move" | "purge" | "purge_version" | "read" | "restore" | "restrict_content" | "update" | "use", readonly "target": "page" | "blogpost" | "comment" | "attachment" | "space" }, readonly "_links"?: GenericLinks }
export const SpacePermissionV2 = Schema.Struct({ "id": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()), "subject": PermissionSubject, "operation": Schema.Struct({ "key": Schema.Literals(["administer", "archive", "copy", "create", "delete", "export", "move", "purge", "purge_version", "read", "restore", "restrict_content", "update", "use"]), "target": Schema.Literals(["page", "blogpost", "comment", "attachment", "space"]).annotate({ "description": "The space or content type that the operation applies to." }) }), "_links": Schema.optionalKey(GenericLinks) }).annotate({ "description": "This object represents a single space permission. Permissions consist of\nat least one operation object with an accompanying subjects object.\n\nThe following combinations of `operation.key` and `operation.target` values are\nvalid for the `operation` object:\n``` bash\n'create': 'page', 'blogpost', 'comment', 'attachment'\n'read': 'space'\n'delete': 'page', 'blogpost', 'comment', 'attachment', 'space'\n'export': 'space'\n'administer': 'space'\n'archive': 'page'\n'restrict_content': 'space'\n```\n\nFor example, to enable Delete Own permission, set the `operation` object to the following:\n```\n\"operation\": {\n    \"key\": \"delete\",\n    \"target\": \"space\"\n}\n```\nTo enable Add/Delete Restrictions permissions, set the `operation` object to the following:\n```\n\"operation\": {\n    \"key\": \"restrict_content\",\n    \"target\": \"space\"\n}\n```" })
export type SpacePermissionRequest = { readonly "subject": PermissionSubject, readonly "operation": { readonly "key": "administer" | "archive" | "copy" | "create" | "delete" | "export" | "move" | "purge" | "purge_version" | "read" | "restore" | "restrict_content" | "update" | "use", readonly "target": "page" | "blogpost" | "comment" | "attachment" | "space" }, readonly "_links"?: GenericLinks, readonly [x: string]: Schema.Json }
export const SpacePermissionRequest = Schema.StructWithRest(Schema.Struct({ "subject": PermissionSubject, "operation": Schema.Struct({ "key": Schema.Literals(["administer", "archive", "copy", "create", "delete", "export", "move", "purge", "purge_version", "read", "restore", "restrict_content", "update", "use"]), "target": Schema.Literals(["page", "blogpost", "comment", "attachment", "space"]).annotate({ "description": "The space or content type that the operation applies to." }) }), "_links": Schema.optionalKey(GenericLinks) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "This object represents the request for the single space permission. Permissions consist of\none operation object with an accompanying subjects object.\n\nThe following combinations of `operation.key` and `operation.target` values are\nvalid for the `operation` object:\n``` bash\n'create': 'page', 'blogpost', 'comment', 'attachment'\n'read': 'space'\n'delete': 'page', 'blogpost', 'comment', 'attachment', 'space'\n'export': 'space'\n'administer': 'space'\n'archive': 'page'\n'restrict_content': 'space'\n```\n\nFor example, to enable Delete Own permission, set the `operation` object to the following:\n```\n\"operation\": {\n    \"key\": \"delete\",\n    \"target\": \"space\"\n}\n```\nTo enable Add/Delete Restrictions permissions, set the `operation` object to the following:\n```\n\"operation\": {\n    \"key\": \"restrict_content\",\n    \"target\": \"space\"\n}\n```" })
export type SpacePermissionCustomContent = { readonly "subject": PermissionSubject, readonly "operations": ReadonlyArray<{ readonly "key": "read" | "create" | "delete", readonly "target": string, readonly "access": boolean }> }
export const SpacePermissionCustomContent = Schema.Struct({ "subject": PermissionSubject, "operations": Schema.Array(Schema.Struct({ "key": Schema.Literals(["read", "create", "delete"]).annotate({ "description": "The operation type" }), "target": Schema.String.annotate({ "description": "The custom content type" }), "access": Schema.Boolean.annotate({ "description": "Grant or restrict access" }) })) }).annotate({ "description": "This object represents a list of space permissions for custom content type for an individual user. Permissions consist of\na subjects object and a list with at least one operation object." })
export type ContentPermissionRequest = { readonly "subject": PermissionSubjectWithGroupId, readonly "operation": "read" | "update" | "delete" }
export const ContentPermissionRequest = Schema.Struct({ "subject": PermissionSubjectWithGroupId, "operation": Schema.Literals(["read", "update", "delete"]).annotate({ "description": "The content permission operation to check." }) }).annotate({ "description": "This object represents the request for the content permission check API." })
export type SearchPageResponseSearchResult = { readonly "results": ReadonlyArray<SearchResult>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "totalSize": number, readonly "cqlQuery": string, readonly "searchDuration": number, readonly "archivedResultCount"?: number, readonly "_links": GenericLinks }
export const SearchPageResponseSearchResult = Schema.Struct({ "results": Schema.Array(SearchResult), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "totalSize": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "cqlQuery": Schema.String, "searchDuration": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "archivedResultCount": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "_links": GenericLinks })
export type ContentTemplateCreate = { readonly "name": string, readonly "templateType": string, readonly "body": ContentTemplateBodyCreate, readonly "description"?: string, readonly "labels"?: ReadonlyArray<Label>, readonly "space"?: { readonly "key": string }, readonly [x: string]: Schema.Json }
export const ContentTemplateCreate = Schema.StructWithRest(Schema.Struct({ "name": Schema.String.annotate({ "description": "The name of the new template." }), "templateType": Schema.String.annotate({ "description": "The type of the new template. Set to `page`." }), "body": ContentTemplateBodyCreate, "description": Schema.optionalKey(Schema.String.annotate({ "description": "A description of the new template." }).check(Schema.isMaxLength(255))), "labels": Schema.optionalKey(Schema.Array(Label).annotate({ "description": "Labels for the new template." })), "space": Schema.optionalKey(Schema.Union([Schema.Struct({ "key": Schema.String }).annotate({ "description": "The key for the space of the new template. Only applies to space templates.\nIf the spaceKey is not specified, the template will be created as a global\ntemplate." })])) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "This object is used to create content templates." })
export type ContentTemplateUpdate = { readonly "templateId": string, readonly "name": string, readonly "templateType": "page", readonly "body": ContentTemplateBodyCreate, readonly "description"?: string, readonly "labels"?: ReadonlyArray<Label>, readonly "space"?: { readonly "key": string }, readonly [x: string]: Schema.Json }
export const ContentTemplateUpdate = Schema.StructWithRest(Schema.Struct({ "templateId": Schema.String.annotate({ "description": "The ID of the template being updated." }), "name": Schema.String.annotate({ "description": "The name of the template. Set to the current `name` if this field is\nnot being updated." }), "templateType": Schema.Literal("page").annotate({ "description": "The type of the template. Set to `page`." }), "body": ContentTemplateBodyCreate, "description": Schema.optionalKey(Schema.String.annotate({ "description": "A description of the template." }).check(Schema.isMaxLength(100))), "labels": Schema.optionalKey(Schema.Array(Label).annotate({ "description": "Labels for the template." })), "space": Schema.optionalKey(Schema.Union([Schema.Struct({ "key": Schema.String }).annotate({ "description": "The key for the space of the template. Required if the template is a\nspace template. Set this to the current `space.key`." })])) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "This object is used to update content templates." })
export type BulkContentBodyConversionInput = { readonly "conversionInputs"?: ReadonlyArray<ContentBodyConversionInput> }
export const BulkContentBodyConversionInput = Schema.Struct({ "conversionInputs": Schema.optionalKey(Schema.Array(ContentBodyConversionInput)) })
export type ContentChildren = { readonly "attachment"?: ContentArray, readonly "comment"?: ContentArray, readonly "page"?: ContentArray, readonly "whiteboard"?: ContentArray, readonly "database"?: ContentArray, readonly "embed"?: ContentArray, readonly "folder"?: ContentArray, readonly "_expandable"?: { readonly "attachment"?: string, readonly "comment"?: string, readonly "page"?: string, readonly "whiteboard"?: string, readonly "database"?: string, readonly "embed"?: string, readonly "folder"?: string, readonly [x: string]: Schema.Json }, readonly "_links"?: GenericLinks, readonly [x: string]: Schema.Json }
export const ContentChildren = Schema.StructWithRest(Schema.Struct({ "attachment": Schema.optionalKey(ContentArray), "comment": Schema.optionalKey(ContentArray), "page": Schema.optionalKey(ContentArray), "whiteboard": Schema.optionalKey(ContentArray), "database": Schema.optionalKey(ContentArray), "embed": Schema.optionalKey(ContentArray), "folder": Schema.optionalKey(ContentArray), "_expandable": Schema.optionalKey(Schema.StructWithRest(Schema.Struct({ "attachment": Schema.optionalKey(Schema.String), "comment": Schema.optionalKey(Schema.String), "page": Schema.optionalKey(Schema.String), "whiteboard": Schema.optionalKey(Schema.String), "database": Schema.optionalKey(Schema.String), "embed": Schema.optionalKey(Schema.String), "folder": Schema.optionalKey(Schema.String) }), [Schema.Record(Schema.String, Schema.Json)])), "_links": Schema.optionalKey(GenericLinks) }), [Schema.Record(Schema.String, Schema.Json)])
export type GroupArray = { readonly "results": ReadonlyArray<Group>, readonly "start": number, readonly "limit": number, readonly "size": number }
export const GroupArray = Schema.Struct({ "results": Schema.Array(Group), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()) })
export type GroupArrayWithLinks = { readonly "results": ReadonlyArray<Group>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "totalSize"?: number, readonly "_links": GenericLinks }
export const GroupArrayWithLinks = Schema.Struct({ "results": Schema.Array(Group), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "totalSize": Schema.optionalKey(Schema.Number.annotate({ "description": "This property will return total count of the objects before pagination is applied.\nThis value is returned if `shouldReturnTotalSize` is set to `true`.", "format": "int64" }).check(Schema.isInt())), "_links": GenericLinks }).annotate({ "description": "Same as GroupArray but with `_links` property." })
export type ContentRestrictionUpdate = { readonly "operation": "administer" | "copy" | "create" | "delete" | "export" | "move" | "purge" | "purge_version" | "read" | "restore" | "update" | "use", readonly "restrictions": { readonly "group"?: ReadonlyArray<{ readonly "type": "group", readonly "id"?: string }>, readonly "user"?: ReadonlyArray<User> | UserArray }, readonly "content"?: Content }
export const ContentRestrictionUpdate = Schema.Struct({ "operation": Schema.Literals(["administer", "copy", "create", "delete", "export", "move", "purge", "purge_version", "read", "restore", "update", "use"]).annotate({ "description": "The restriction operation applied to content." }), "restrictions": Schema.Struct({ "group": Schema.optionalKey(Schema.Array(Schema.Struct({ "type": Schema.Literal("group").annotate({ "description": "Set to 'group'." }), "id": Schema.optionalKey(Schema.String.annotate({ "description": "The id of the group." })) }).annotate({ "description": "A group that the restriction will be applied to." })).annotate({ "description": "The groups that the restrictions will be applied to. This array must\nhave at least one item, otherwise it should be omitted." })), "user": Schema.optionalKey(Schema.Union([Schema.Array(User), UserArray], { mode: "oneOf" })) }).annotate({ "description": "The users/groups that the restrictions will be applied to. At least one of\n`user` or `group` must be specified for this object." }), "content": Schema.optionalKey(Content) })
export type Version = { readonly "by"?: User, readonly "when": string, readonly "friendlyWhen"?: string | null, readonly "message"?: string | null, readonly "number": number, readonly "minorEdit": boolean, readonly "content"?: Content, readonly "collaborators"?: UsersUserKeys, readonly "_expandable"?: { readonly "content"?: string, readonly "collaborators"?: string }, readonly "_links"?: GenericLinks, readonly "contentTypeModified"?: boolean, readonly "confRev"?: string | null, readonly "syncRev"?: string | null, readonly "syncRevSource"?: string | null }
export const Version = Schema.Union([Schema.Struct({ "by": Schema.optionalKey(User), "when": Schema.Union([Schema.String.annotate({ "format": "date-time" })]), "friendlyWhen": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "message": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "number": Schema.Number.annotate({ "description": "Set this to the current version number incremented by one", "format": "int32" }).check(Schema.isInt()), "minorEdit": Schema.Boolean.annotate({ "description": "If `minorEdit` is set to 'true', no notification email or activity\nstream will be generated for the change." }), "content": Schema.optionalKey(Content), "collaborators": Schema.optionalKey(UsersUserKeys), "_expandable": Schema.optionalKey(Schema.Struct({ "content": Schema.optionalKey(Schema.String), "collaborators": Schema.optionalKey(Schema.String) })), "_links": Schema.optionalKey(GenericLinks), "contentTypeModified": Schema.optionalKey(Schema.Boolean.annotate({ "description": "True if content type is modifed in this version (e.g. page to blog)" })), "confRev": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The revision id provided by confluence to be used as a revision in Synchrony" })), "syncRev": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The revision id provided by Synchrony" })), "syncRevSource": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Source of the synchrony revision" })) })])
export type AuditRecordArray = { readonly "results": ReadonlyArray<AuditRecord>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links": GenericLinks }
export const AuditRecordArray = Schema.Struct({ "results": Schema.Array(AuditRecord), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
export type ThemeArray = { readonly "results": ReadonlyArray<ThemeNoLinks>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links": GenericLinks }
export const ThemeArray = Schema.Struct({ "results": Schema.Array(ThemeNoLinks), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
export type LabeledContentPageResponse = { readonly "results": ReadonlyArray<LabeledContent>, readonly "start"?: number, readonly "limit"?: number, readonly "size": number }
export const LabeledContentPageResponse = Schema.Struct({ "results": Schema.Array(LabeledContent), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()) })
export type LongTaskStatusArray = { readonly "results": ReadonlyArray<LongTaskStatus>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links": GenericLinks }
export const LongTaskStatusArray = Schema.Struct({ "results": Schema.Array(LongTaskStatus), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
export type RelationArray = { readonly "results": ReadonlyArray<Relation>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links": GenericLinks }
export const RelationArray = Schema.Struct({ "results": Schema.Array(Relation), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
export type LookAndFeel = { readonly "headings": { readonly "color": string }, readonly "links": { readonly "color": string }, readonly "menus": MenusLookAndFeel, readonly "header": HeaderLookAndFeel, readonly "horizontalHeader"?: HorizontalHeaderLookAndFeel, readonly "content": ContentLookAndFeel, readonly "bordersAndDividers": { readonly "color": string }, readonly "spaceReference"?: {  } | null }
export const LookAndFeel = Schema.Struct({ "headings": Schema.Struct({ "color": Schema.String }), "links": Schema.Struct({ "color": Schema.String }), "menus": MenusLookAndFeel, "header": HeaderLookAndFeel, "horizontalHeader": Schema.optionalKey(HorizontalHeaderLookAndFeel), "content": ContentLookAndFeel, "bordersAndDividers": Schema.Struct({ "color": Schema.String }), "spaceReference": Schema.optionalKey(Schema.Union([Schema.Struct({  }), Schema.Null])) })
export type LookAndFeelWithLinks = { readonly "headings": { readonly "color": string }, readonly "links": { readonly "color": string }, readonly "menus": MenusLookAndFeel, readonly "header": HeaderLookAndFeel, readonly "horizontalHeader"?: HorizontalHeaderLookAndFeel, readonly "content": ContentLookAndFeel, readonly "bordersAndDividers": { readonly "color": string }, readonly "spaceReference"?: {  } | null, readonly "_links"?: GenericLinks }
export const LookAndFeelWithLinks = Schema.Struct({ "headings": Schema.Struct({ "color": Schema.String }), "links": Schema.Struct({ "color": Schema.String }), "menus": MenusLookAndFeel, "header": HeaderLookAndFeel, "horizontalHeader": Schema.optionalKey(HorizontalHeaderLookAndFeel), "content": ContentLookAndFeel, "bordersAndDividers": Schema.Struct({ "color": Schema.String }), "spaceReference": Schema.optionalKey(Schema.Union([Schema.Struct({  }), Schema.Null])), "_links": Schema.optionalKey(GenericLinks) }).annotate({ "description": "Look and feel settings returned after an update." })
export type AsyncContentBody = { readonly "value"?: string, readonly "representation"?: "view" | "export_view" | "styled_view" | "storage" | "editor" | "editor2" | "anonymous_export_view" | "wiki" | "atlas_doc_format", readonly "renderTaskId"?: string, readonly "error"?: string, readonly "status"?: "WORKING" | "QUEUED" | "FAILED" | "COMPLETED" | "RERUNNING", readonly "embeddedContent"?: ReadonlyArray<EmbeddedContent>, readonly "webresource"?: WebResourceDependencies, readonly "mediaToken"?: { readonly "collectionIds"?: ReadonlyArray<string>, readonly "contentId"?: string, readonly "expiryDateTime"?: string, readonly "fileIds"?: ReadonlyArray<string>, readonly "token"?: string }, readonly "_expandable"?: { readonly "content"?: string, readonly "embeddedContent"?: string, readonly "webresource"?: string, readonly "mediaToken"?: string }, readonly "_links"?: GenericLinks }
export const AsyncContentBody = Schema.Struct({ "value": Schema.optionalKey(Schema.String), "representation": Schema.optionalKey(Schema.Literals(["view", "export_view", "styled_view", "storage", "editor", "editor2", "anonymous_export_view", "wiki", "atlas_doc_format"])), "renderTaskId": Schema.optionalKey(Schema.String), "error": Schema.optionalKey(Schema.String), "status": Schema.optionalKey(Schema.Literals(["WORKING", "QUEUED", "FAILED", "COMPLETED", "RERUNNING"]).annotate({ "description": "Rerunning is reserved for when the job is working, but there is a previous run's value in the cache. You may choose to continue polling, or use the cached value." })), "embeddedContent": Schema.optionalKey(Schema.Array(EmbeddedContent)), "webresource": Schema.optionalKey(WebResourceDependencies), "mediaToken": Schema.optionalKey(Schema.Struct({ "collectionIds": Schema.optionalKey(Schema.Array(Schema.String)), "contentId": Schema.optionalKey(Schema.String), "expiryDateTime": Schema.optionalKey(Schema.String), "fileIds": Schema.optionalKey(Schema.Array(Schema.String)), "token": Schema.optionalKey(Schema.String) })), "_expandable": Schema.optionalKey(Schema.Struct({ "content": Schema.optionalKey(Schema.String), "embeddedContent": Schema.optionalKey(Schema.String), "webresource": Schema.optionalKey(Schema.String), "mediaToken": Schema.optionalKey(Schema.String) })), "_links": Schema.optionalKey(GenericLinks) })
export type ContentBody = { readonly "value": string, readonly "representation": "view" | "export_view" | "styled_view" | "storage" | "editor" | "editor2" | "anonymous_export_view" | "wiki" | "atlas_doc_format" | "raw", readonly "embeddedContent"?: ReadonlyArray<EmbeddedContent>, readonly "webresource"?: WebResourceDependencies, readonly "mediaToken"?: { readonly "collectionIds"?: ReadonlyArray<string>, readonly "contentId"?: string, readonly "expiryDateTime"?: string, readonly "fileIds"?: ReadonlyArray<string>, readonly "token"?: string }, readonly "_expandable"?: { readonly "content"?: string, readonly "embeddedContent"?: string, readonly "webresource"?: string, readonly "mediaToken"?: string }, readonly "_links"?: GenericLinks }
export const ContentBody = Schema.Struct({ "value": Schema.String, "representation": Schema.Literals(["view", "export_view", "styled_view", "storage", "editor", "editor2", "anonymous_export_view", "wiki", "atlas_doc_format", "raw"]), "embeddedContent": Schema.optionalKey(Schema.Array(EmbeddedContent)), "webresource": Schema.optionalKey(WebResourceDependencies), "mediaToken": Schema.optionalKey(Schema.Struct({ "collectionIds": Schema.optionalKey(Schema.Array(Schema.String)), "contentId": Schema.optionalKey(Schema.String), "expiryDateTime": Schema.optionalKey(Schema.String), "fileIds": Schema.optionalKey(Schema.Array(Schema.String)), "token": Schema.optionalKey(Schema.String) })), "_expandable": Schema.optionalKey(Schema.Struct({ "content": Schema.optionalKey(Schema.String), "embeddedContent": Schema.optionalKey(Schema.String), "webresource": Schema.optionalKey(Schema.String), "mediaToken": Schema.optionalKey(Schema.String) })), "_links": Schema.optionalKey(GenericLinks) })
export type BulkUserLookupArray = { readonly "results": ReadonlyArray<BulkUserLookup>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links": GenericLinks }
export const BulkUserLookupArray = Schema.Struct({ "results": Schema.Array(BulkUserLookup), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
export type SpaceWatch = { readonly "type": string, readonly "watcher": WatchUser, readonly "spaceKey"?: string, readonly "labelName"?: string, readonly "prefix"?: string }
export const SpaceWatch = Schema.Struct({ "type": Schema.String, "watcher": WatchUser, "spaceKey": Schema.optionalKey(Schema.String), "labelName": Schema.optionalKey(Schema.String), "prefix": Schema.optionalKey(Schema.String) })
export type Watch = { readonly "type": string, readonly "watcher": WatchUser, readonly "contentId": number }
export const Watch = Schema.Struct({ "type": Schema.String, "watcher": WatchUser, "contentId": Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()) })
export type ContentRestriction = { readonly "operation": "administer" | "copy" | "create" | "delete" | "export" | "move" | "purge" | "purge_version" | "read" | "restore" | "update" | "use", readonly "restrictions"?: { readonly "user"?: UserArray, readonly "group"?: GroupArray, readonly "_expandable"?: { readonly "user"?: string, readonly "group"?: string } }, readonly "content"?: Content, readonly "_expandable": { readonly "restrictions"?: string, readonly "content"?: string }, readonly "_links": GenericLinks }
export const ContentRestriction = Schema.Struct({ "operation": Schema.Literals(["administer", "copy", "create", "delete", "export", "move", "purge", "purge_version", "read", "restore", "update", "use"]), "restrictions": Schema.optionalKey(Schema.Struct({ "user": Schema.optionalKey(UserArray), "group": Schema.optionalKey(GroupArray), "_expandable": Schema.optionalKey(Schema.Struct({ "user": Schema.optionalKey(Schema.String), "group": Schema.optionalKey(Schema.String) })) })), "content": Schema.optionalKey(Content), "_expandable": Schema.Struct({ "restrictions": Schema.optionalKey(Schema.String), "content": Schema.optionalKey(Schema.String) }), "_links": GenericLinks })
export type ContentRestrictionAddOrUpdateArray = { readonly "results": ReadonlyArray<ContentRestrictionUpdate>, readonly "start"?: number, readonly "limit"?: number, readonly "size"?: number, readonly "restrictionsHash"?: string, readonly "_links"?: GenericLinks } | ReadonlyArray<ContentRestrictionUpdate>
export const ContentRestrictionAddOrUpdateArray = Schema.Union([Schema.Struct({ "results": Schema.Array(ContentRestrictionUpdate), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "size": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "restrictionsHash": Schema.optionalKey(Schema.String.annotate({ "description": "This property is used by the UI to figure out whether a set of restrictions\nhas changed." })), "_links": Schema.optionalKey(GenericLinks) }), Schema.Array(ContentRestrictionUpdate)], { mode: "oneOf" })
export type AttachmentPropertiesUpdateBody = { readonly "id": string, readonly "type": string, readonly "status"?: string, readonly "title"?: string, readonly "container"?: Container, readonly "metadata"?: { readonly "mediaType"?: string }, readonly "extensions"?: {  }, readonly "version": Version, readonly [x: string]: Schema.Json }
export const AttachmentPropertiesUpdateBody = Schema.StructWithRest(Schema.Struct({ "id": Schema.String, "type": Schema.String.annotate({ "description": "Set this to \"attachment\"" }), "status": Schema.optionalKey(Schema.String), "title": Schema.optionalKey(Schema.String), "container": Schema.optionalKey(Container), "metadata": Schema.optionalKey(Schema.Struct({ "mediaType": Schema.optionalKey(Schema.String) })), "extensions": Schema.optionalKey(Schema.Struct({  })), "version": Version }), [Schema.Record(Schema.String, Schema.Json)])
export type ContentMetadata = { readonly "currentuser"?: { readonly "favourited"?: { readonly "isFavourite"?: boolean, readonly "favouritedDate"?: string }, readonly "lastmodified"?: { readonly "version"?: Version, readonly "friendlyLastModified"?: string }, readonly "lastcontributed"?: { readonly "status"?: string, readonly "when"?: string }, readonly "viewed"?: { readonly "lastSeen"?: string, readonly "friendlyLastSeen"?: string }, readonly "scheduled"?: {  }, readonly "_expandable"?: { readonly "favourited"?: string, readonly "lastmodified"?: string, readonly "lastcontributed"?: string, readonly "viewed"?: string, readonly "scheduled"?: string } }, readonly "properties"?: GenericLinks, readonly "frontend"?: { readonly [x: string]: Schema.Json }, readonly "labels"?: LabelArray | ReadonlyArray<Label>, readonly [x: string]: Schema.Json }
export const ContentMetadata = Schema.StructWithRest(Schema.Struct({ "currentuser": Schema.optionalKey(Schema.Struct({ "favourited": Schema.optionalKey(Schema.Struct({ "isFavourite": Schema.optionalKey(Schema.Boolean), "favouritedDate": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })) })), "lastmodified": Schema.optionalKey(Schema.Struct({ "version": Schema.optionalKey(Version), "friendlyLastModified": Schema.optionalKey(Schema.String) })), "lastcontributed": Schema.optionalKey(Schema.Struct({ "status": Schema.optionalKey(Schema.String), "when": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })) })), "viewed": Schema.optionalKey(Schema.Struct({ "lastSeen": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "friendlyLastSeen": Schema.optionalKey(Schema.String) })), "scheduled": Schema.optionalKey(Schema.Struct({  })), "_expandable": Schema.optionalKey(Schema.Struct({ "favourited": Schema.optionalKey(Schema.String), "lastmodified": Schema.optionalKey(Schema.String), "lastcontributed": Schema.optionalKey(Schema.String), "viewed": Schema.optionalKey(Schema.String), "scheduled": Schema.optionalKey(Schema.String) })) })), "properties": Schema.optionalKey(GenericLinks), "frontend": Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)), "labels": Schema.optionalKey(Schema.Union([LabelArray, Schema.Array(Label)], { mode: "oneOf" })) }), [Schema.Record(Schema.String, Schema.Json)]).annotate({ "description": "Metadata object for page, blogpost, comment content" })
export type SpaceProperty = { readonly "id": string, readonly "key": string, readonly "value": ReadonlyArray<string> | boolean | { readonly [x: string]: Schema.Json } | string, readonly "version"?: Version, readonly "space"?: Space, readonly "_links"?: GenericLinks, readonly "_expandable": { readonly "version"?: string, readonly "space"?: string } }
export const SpaceProperty = Schema.Struct({ "id": Schema.String, "key": Schema.String, "value": Schema.Union([Schema.Array(Schema.String), Schema.Boolean, Schema.Record(Schema.String, Schema.Json), Schema.String], { mode: "oneOf" }), "version": Schema.optionalKey(Version), "space": Schema.optionalKey(Space), "_links": Schema.optionalKey(GenericLinks), "_expandable": Schema.Struct({ "version": Schema.optionalKey(Schema.String), "space": Schema.optionalKey(Schema.String) }) })
export type LabelDetails = { readonly "label": Label, readonly "associatedContents"?: LabeledContentPageResponse }
export const LabelDetails = Schema.Struct({ "label": Label, "associatedContents": Schema.optionalKey(LabeledContentPageResponse) })
export type LookAndFeelSettings = { readonly "selected": "global" | "custom", readonly "global": LookAndFeel, readonly "theme"?: LookAndFeel, readonly "custom": LookAndFeel }
export const LookAndFeelSettings = Schema.Struct({ "selected": Schema.Literals(["global", "custom"]), "global": LookAndFeel, "theme": Schema.optionalKey(LookAndFeel), "custom": LookAndFeel })
export type AsyncContentBodyArray = ReadonlyArray<AsyncContentBody>
export const AsyncContentBodyArray = Schema.Array(AsyncContentBody)
export type ContentTemplateBody = { readonly "view"?: ContentBody, readonly "export_view"?: ContentBody, readonly "styled_view"?: ContentBody, readonly "storage"?: ContentBody, readonly "editor"?: ContentBody, readonly "editor2"?: ContentBody, readonly "wiki"?: ContentBody, readonly "atlas_doc_format"?: ContentBody, readonly "anonymous_export_view"?: ContentBody }
export const ContentTemplateBody = Schema.Struct({ "view": Schema.optionalKey(ContentBody), "export_view": Schema.optionalKey(ContentBody), "styled_view": Schema.optionalKey(ContentBody), "storage": Schema.optionalKey(ContentBody), "editor": Schema.optionalKey(ContentBody), "editor2": Schema.optionalKey(ContentBody), "wiki": Schema.optionalKey(ContentBody), "atlas_doc_format": Schema.optionalKey(ContentBody), "anonymous_export_view": Schema.optionalKey(ContentBody) }).annotate({ "description": "The body of the new content. Does not apply to attachments.\nOnly one body format should be specified as the property for\nthis object, e.g. `storage`.\n\nNote, `editor2` format is used by Atlassian only. `anonymous_export_view` is\nthe same as `export_view` format but only content viewable by an anonymous\nuser is included." })
export type SpaceWatchArray = { readonly "results": ReadonlyArray<SpaceWatch>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links"?: GenericLinks }
export const SpaceWatchArray = Schema.Struct({ "results": Schema.Array(SpaceWatch), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": Schema.optionalKey(GenericLinks) })
export type WatchArray = { readonly "results": ReadonlyArray<Watch>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links": GenericLinks }
export const WatchArray = Schema.Struct({ "results": Schema.Array(Watch), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
export type ContentRestrictionArray = { readonly "results": ReadonlyArray<ContentRestriction>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "restrictionsHash": string, readonly "_links": GenericLinks }
export const ContentRestrictionArray = Schema.Struct({ "results": Schema.Array(ContentRestriction), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "restrictionsHash": Schema.String.annotate({ "description": "This property is used by the UI to figure out whether a set of restrictions\nhas changed." }), "_links": GenericLinks })
export type BlueprintTemplate = { readonly "templateId": string, readonly "originalTemplate": { readonly "pluginKey": string, readonly "moduleKey": string }, readonly "referencingBlueprint": string, readonly "name": string, readonly "description": string, readonly "space"?: { readonly [x: string]: Schema.Json }, readonly "labels": ReadonlyArray<Label>, readonly "templateType": string, readonly "editorVersion"?: string, readonly "body"?: ContentTemplateBody, readonly "_expandable"?: { readonly "body"?: string }, readonly "_links": GenericLinks }
export const BlueprintTemplate = Schema.Struct({ "templateId": Schema.String, "originalTemplate": Schema.Struct({ "pluginKey": Schema.String, "moduleKey": Schema.String }), "referencingBlueprint": Schema.String, "name": Schema.String, "description": Schema.String, "space": Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)), "labels": Schema.Array(Label), "templateType": Schema.String, "editorVersion": Schema.optionalKey(Schema.String), "body": Schema.optionalKey(ContentTemplateBody), "_expandable": Schema.optionalKey(Schema.Struct({ "body": Schema.optionalKey(Schema.String) })), "_links": GenericLinks })
export type ContentTemplate = { readonly "templateId": string, readonly "originalTemplate"?: { readonly "pluginKey"?: string, readonly "moduleKey"?: string }, readonly "referencingBlueprint"?: string, readonly "name": string, readonly "description": string, readonly "space"?: { readonly [x: string]: Schema.Json }, readonly "labels": ReadonlyArray<Label>, readonly "templateType": string, readonly "editorVersion"?: string, readonly "body"?: ContentTemplateBody, readonly "_expandable"?: { readonly "body"?: string }, readonly "_links": GenericLinks }
export const ContentTemplate = Schema.Struct({ "templateId": Schema.String, "originalTemplate": Schema.optionalKey(Schema.Struct({ "pluginKey": Schema.optionalKey(Schema.String), "moduleKey": Schema.optionalKey(Schema.String) })), "referencingBlueprint": Schema.optionalKey(Schema.String), "name": Schema.String, "description": Schema.String, "space": Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)), "labels": Schema.Array(Label), "templateType": Schema.String, "editorVersion": Schema.optionalKey(Schema.String), "body": Schema.optionalKey(ContentTemplateBody), "_expandable": Schema.optionalKey(Schema.Struct({ "body": Schema.optionalKey(Schema.String) })), "_links": GenericLinks })
export type BlueprintTemplateArray = { readonly "results": ReadonlyArray<BlueprintTemplate>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links": GenericLinks }
export const BlueprintTemplateArray = Schema.Struct({ "results": Schema.Array(BlueprintTemplate), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
export type ContentTemplateArray = { readonly "results": ReadonlyArray<ContentTemplate>, readonly "start": number, readonly "limit": number, readonly "size": number, readonly "_links": GenericLinks }
export const ContentTemplateArray = Schema.Struct({ "results": Schema.Array(ContentTemplate), "start": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "limit": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "size": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "_links": GenericLinks })
// recursive definitions
const __recursive_User = Schema.Union([Schema.Struct({ "type": Schema.Literals(["known", "unknown", "anonymous", "user"]), "username": Schema.optionalKey(GenericUserName), "userKey": Schema.optionalKey(GenericUserKey), "accountId": Schema.optionalKey(GenericAccountId), "accountType": Schema.optionalKey(Schema.Literals(["atlassian", "app", ""]).annotate({ "description": "The account type of the user, may return empty string if unavailable. App is if the user is a bot user created on behalf of an Atlassian app." })), "email": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The email address of the user. Depending on the user's privacy setting, this may return an empty string." })), "publicName": Schema.optionalKey(Schema.String.annotate({ "description": "The public name or nickname of the user. Will always contain a value." })), "profilePicture": Schema.optionalKey(Icon), "displayName": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "The displays name of the user. Depending on the user's privacy setting, this may be the same as publicName." })), "timeZone": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "This displays user time zone. Depending on the user's privacy setting, this may return null." })), "externalCollaborator": Schema.optionalKey(Schema.Boolean.annotate({ "description": "This is deprecated. Use `isGuest` instead to find out whether the user is a guest user." })), "isExternalCollaborator": Schema.optionalKey(Schema.Boolean.annotate({ "description": "This is deprecated. Use `isGuest` instead to find out whether the user is a guest user." })), "isGuest": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether the user is a guest user" })), "operations": Schema.optionalKey(Schema.Union([Schema.Array(Schema.Struct({ "operation": Schema.Literals(["administer", "archive", "clear_permissions", "copy", "create", "create_space", "delete", "export", "move", "purge", "purge_version", "read", "restore", "restrict_content", "update", "use"]).annotate({ "description": "The operation itself." }), "targetType": Schema.String.annotate({ "description": "The space or content type that the operation applies to. Could be one of- - application - page - blogpost - comment - attachment - space" }) }).annotate({ "description": "An operation and the target entity that it applies to, e.g. create page." }))])), "details": Schema.optionalKey(UserDetails), "personalSpace": Schema.optionalKey(Space), "_expandable": Schema.optionalKey(Schema.Struct({ "operations": Schema.optionalKey(Schema.String), "details": Schema.optionalKey(Schema.String), "personalSpace": Schema.optionalKey(Schema.String) })), "_links": Schema.optionalKey(GenericLinks) })])
const __recursive_Space = Schema.Union([Schema.Struct({ "id": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "key": Schema.String, "alias": Schema.optionalKey(Schema.String), "name": Schema.String, "icon": Schema.optionalKey(Icon), "description": Schema.optionalKey(Schema.Struct({ "plain": Schema.optionalKey(SpaceDescription), "view": Schema.optionalKey(SpaceDescription), "_expandable": Schema.optionalKey(Schema.Struct({ "view": Schema.optionalKey(Schema.String), "plain": Schema.optionalKey(Schema.String) })) })), "homepage": Schema.optionalKey(Content), "type": Schema.String, "metadata": Schema.optionalKey(Schema.Struct({ "labels": Schema.optionalKey(LabelArray), "_expandable": Schema.optionalKey(Schema.Struct({  })) })), "operations": Schema.optionalKey(Schema.Array(OperationCheckResult)), "permissions": Schema.optionalKey(Schema.Array(Schema.Json)), "status": Schema.String, "settings": Schema.optionalKey(SpaceSettings), "theme": Schema.optionalKey(Theme), "lookAndFeel": Schema.optionalKey(LookAndFeel), "history": Schema.optionalKey(Schema.Struct({ "createdDate": Schema.String.annotate({ "format": "date-time" }), "createdBy": Schema.optionalKey(User) })), "_expandable": Schema.Struct({ "settings": Schema.optionalKey(Schema.String), "metadata": Schema.optionalKey(Schema.String), "operations": Schema.optionalKey(Schema.String), "lookAndFeel": Schema.optionalKey(Schema.String), "permissions": Schema.optionalKey(Schema.String), "icon": Schema.optionalKey(Schema.String), "description": Schema.optionalKey(Schema.String), "theme": Schema.optionalKey(Schema.String), "history": Schema.optionalKey(Schema.String), "homepage": Schema.optionalKey(Schema.String), "identifiers": Schema.optionalKey(Schema.String) }), "_links": GenericLinks })])
// schemas
export type GetAuditRecordsParams = { readonly "startDate"?: string, readonly "endDate"?: string, readonly "searchString"?: string, readonly "start"?: number, readonly "limit"?: number }
export const GetAuditRecordsParams = Schema.Struct({ "startDate": Schema.optionalKey(Schema.String), "endDate": Schema.optionalKey(Schema.String), "searchString": Schema.optionalKey(Schema.String), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetAuditRecords200 = AuditRecordArray
export const GetAuditRecords200 = AuditRecordArray
export type CreateAuditRecordRequestJson = AuditRecordCreate
export const CreateAuditRecordRequestJson = AuditRecordCreate
export type CreateAuditRecord200 = AuditRecord
export const CreateAuditRecord200 = AuditRecord
export type ExportAuditRecordsParams = { readonly "startDate"?: string, readonly "endDate"?: string, readonly "searchString"?: string, readonly "format"?: "csv" | "zip" }
export const ExportAuditRecordsParams = Schema.Struct({ "startDate": Schema.optionalKey(Schema.String), "endDate": Schema.optionalKey(Schema.String), "searchString": Schema.optionalKey(Schema.String), "format": Schema.optionalKey(Schema.Literals(["csv", "zip"])) })
export type GetRetentionPeriod200 = RetentionPeriod
export const GetRetentionPeriod200 = RetentionPeriod
export type SetRetentionPeriodRequestJson = RetentionPeriod
export const SetRetentionPeriodRequestJson = RetentionPeriod
export type SetRetentionPeriod200 = RetentionPeriod
export const SetRetentionPeriod200 = RetentionPeriod
export type GetAuditRecordsForTimePeriodParams = { readonly "number"?: number, readonly "units"?: "NANOS" | "MICROS" | "MILLIS" | "SECONDS" | "MINUTES" | "HOURS" | "HALF_DAYS" | "DAYS" | "WEEKS" | "MONTHS" | "YEARS" | "DECADES" | "CENTURIES", readonly "searchString"?: string, readonly "start"?: number, readonly "limit"?: number }
export const GetAuditRecordsForTimePeriodParams = Schema.Struct({ "number": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "units": Schema.optionalKey(Schema.Literals(["NANOS", "MICROS", "MILLIS", "SECONDS", "MINUTES", "HOURS", "HALF_DAYS", "DAYS", "WEEKS", "MONTHS", "YEARS", "DECADES", "CENTURIES"])), "searchString": Schema.optionalKey(Schema.String), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetAuditRecordsForTimePeriod200 = AuditRecordArray
export const GetAuditRecordsForTimePeriod200 = AuditRecordArray
export type ArchivePagesRequestJson = { readonly "pages"?: ReadonlyArray<{ readonly "id": number }> }
export const ArchivePagesRequestJson = Schema.Struct({ "pages": Schema.optionalKey(Schema.Array(Schema.Struct({ "id": Schema.Number.annotate({ "description": "The `id` of the page to be archived.", "format": "int64" }).check(Schema.isInt()) }))) })
export type ArchivePages202 = LongTask
export const ArchivePages202 = LongTask
export type PublishSharedDraftParams = { readonly "status"?: string, readonly "expand"?: ReadonlyArray<string> }
export const PublishSharedDraftParams = Schema.Struct({ "status": Schema.optionalKey(Schema.String), "expand": Schema.optionalKey(Schema.Array(Schema.String)) })
export type PublishSharedDraftRequestJson = ContentBlueprintDraft
export const PublishSharedDraftRequestJson = ContentBlueprintDraft
export type PublishSharedDraft200 = Content
export const PublishSharedDraft200 = Content
export type PublishLegacyDraftParams = { readonly "status"?: string, readonly "expand"?: ReadonlyArray<string> }
export const PublishLegacyDraftParams = Schema.Struct({ "status": Schema.optionalKey(Schema.String), "expand": Schema.optionalKey(Schema.Array(Schema.String)) })
export type PublishLegacyDraftRequestJson = ContentBlueprintDraft
export const PublishLegacyDraftRequestJson = ContentBlueprintDraft
export type PublishLegacyDraft200 = Content
export const PublishLegacyDraft200 = Content
export type SearchContentByCQLParams = { readonly "cql": string, readonly "cqlcontext"?: string, readonly "expand"?: ReadonlyArray<string>, readonly "cursor"?: string, readonly "limit"?: number }
export const SearchContentByCQLParams = Schema.Struct({ "cql": Schema.String, "cqlcontext": Schema.optionalKey(Schema.String), "expand": Schema.optionalKey(Schema.Array(Schema.String)), "cursor": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type SearchContentByCQL200 = ContentArray
export const SearchContentByCQL200 = ContentArray
export type DeletePageTree202 = LongTask
export const DeletePageTree202 = LongTask
export type MovePage200 = { readonly "pageId"?: ContentId }
export const MovePage200 = Schema.Struct({ "pageId": Schema.optionalKey(ContentId) })
export type CreateOrUpdateAttachmentsParams = { readonly "status"?: "current" | "draft", readonly "X-Atlassian-Token": "nocheck" }
export const CreateOrUpdateAttachmentsParams = Schema.Struct({ "status": Schema.optionalKey(Schema.Literals(["current", "draft"])), "X-Atlassian-Token": Schema.Literal("nocheck") })
export type CreateOrUpdateAttachmentsRequestFormData = Schema.Json
export const CreateOrUpdateAttachmentsRequestFormData = Schema.Json
export type CreateOrUpdateAttachments200 = ContentArray
export const CreateOrUpdateAttachments200 = ContentArray
export type CreateAttachmentParams = { readonly "status"?: "current" | "draft" }
export const CreateAttachmentParams = Schema.Struct({ "status": Schema.optionalKey(Schema.Literals(["current", "draft"])) })
export type CreateAttachmentRequestFormData = { readonly "file": string, readonly "comment"?: string, readonly "minorEdit": string, readonly [x: string]: Schema.Json }
export const CreateAttachmentRequestFormData = Schema.StructWithRest(Schema.Struct({ "file": Schema.String.annotate({ "description": "The relative location and name of the attachment to be added to\nthe content.", "format": "binary" }), "comment": Schema.optionalKey(Schema.String.annotate({ "description": "The comment for the attachment that is being added.\nIf you specify a comment, then every file must have a comment and\nthe comments must be in the same order as the files. Alternatively,\ndon't specify any comments.", "format": "binary" })), "minorEdit": Schema.String.annotate({ "description": "If `minorEdits` is set to 'true', no notification email or activity stream\nwill be generated when the attachment is added to the content.", "format": "binary" }) }), [Schema.Record(Schema.String, Schema.Json)])
export type CreateAttachment200 = ContentArray
export const CreateAttachment200 = ContentArray
export type UpdateAttachmentPropertiesRequestJson = AttachmentPropertiesUpdateBody
export const UpdateAttachmentPropertiesRequestJson = AttachmentPropertiesUpdateBody
export type UpdateAttachmentProperties200 = Content
export const UpdateAttachmentProperties200 = Content
export type UpdateAttachmentDataRequestFormData = { readonly "file": string, readonly "comment"?: string, readonly "minorEdit": string, readonly [x: string]: Schema.Json }
export const UpdateAttachmentDataRequestFormData = Schema.StructWithRest(Schema.Struct({ "file": Schema.String.annotate({ "description": "The relative location and name of the attachment to be added to\nthe content.", "format": "binary" }), "comment": Schema.optionalKey(Schema.String.annotate({ "description": "The comment for the attachment that is being added.\nIf you specify a comment, then every file must have a comment and\nthe comments must be in the same order as the files. Alternatively,\ndon't specify any comments.", "format": "binary" })), "minorEdit": Schema.String.annotate({ "description": "If `minorEdits` is set to 'true', no notification email or activity stream\nwill be generated when the attachment is added to the content.", "format": "binary" }) }), [Schema.Record(Schema.String, Schema.Json)])
export type UpdateAttachmentData200 = Content
export const UpdateAttachmentData200 = Content
export type DownloadAttatchmentParams = { readonly "version"?: number, readonly "status"?: ReadonlyArray<string> }
export const DownloadAttatchmentParams = Schema.Struct({ "version": Schema.optionalKey(Schema.Number.check(Schema.isInt())), "status": Schema.optionalKey(Schema.Array(Schema.String)) })
export type GetContentDescendantsParams = { readonly "expand"?: ReadonlyArray<"attachment" | "comment" | "page"> }
export const GetContentDescendantsParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["attachment", "comment", "page"]))) })
export type GetContentDescendants200 = ContentChildren
export const GetContentDescendants200 = ContentChildren
export type GetDescendantsOfTypeParams = { readonly "depth"?: "all" | "root" | "<any positive integer argument in the range of 1 and 100>", readonly "expand"?: ReadonlyArray<string>, readonly "start"?: number, readonly "limit"?: number }
export const GetDescendantsOfTypeParams = Schema.Struct({ "depth": Schema.optionalKey(Schema.Literals(["all", "root", "<any positive integer argument in the range of 1 and 100>"])), "expand": Schema.optionalKey(Schema.Array(Schema.String)), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetDescendantsOfType200 = ContentArray
export const GetDescendantsOfType200 = ContentArray
export type GetMacroBodyByMacroId200 = MacroInstance
export const GetMacroBodyByMacroId200 = MacroInstance
export type GetAndConvertMacroBodyByMacroIdParams = { readonly "expand"?: ReadonlyArray<string>, readonly "spaceKeyContext"?: string, readonly "embeddedContentRender"?: "current" | "version-at-save" }
export const GetAndConvertMacroBodyByMacroIdParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.String)), "spaceKeyContext": Schema.optionalKey(Schema.String), "embeddedContentRender": Schema.optionalKey(Schema.Literals(["current", "version-at-save"])) })
export type GetAndConvertMacroBodyByMacroId200 = ContentBody
export const GetAndConvertMacroBodyByMacroId200 = ContentBody
export type GetAndAsyncConvertMacroBodyByMacroIdParams = { readonly "expand"?: ReadonlyArray<string>, readonly "allowCache"?: boolean, readonly "spaceKeyContext"?: string, readonly "embeddedContentRender"?: "current" | "version-at-save" }
export const GetAndAsyncConvertMacroBodyByMacroIdParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.String)), "allowCache": Schema.optionalKey(Schema.Boolean), "spaceKeyContext": Schema.optionalKey(Schema.String), "embeddedContentRender": Schema.optionalKey(Schema.Literals(["current", "version-at-save"])) })
export type GetAndAsyncConvertMacroBodyByMacroId200 = AsyncId
export const GetAndAsyncConvertMacroBodyByMacroId200 = AsyncId
export type AddLabelsToContentRequestJson = LabelCreateArray | LabelCreate
export const AddLabelsToContentRequestJson = Schema.Union([LabelCreateArray, LabelCreate], { mode: "oneOf" })
export type AddLabelsToContent200 = LabelArray
export const AddLabelsToContent200 = LabelArray
export type RemoveLabelFromContentUsingQueryParameterParams = { readonly "name": string }
export const RemoveLabelFromContentUsingQueryParameterParams = Schema.Struct({ "name": Schema.String })
export type GetWatchesForPageParams = { readonly "start"?: number, readonly "limit"?: number }
export const GetWatchesForPageParams = Schema.Struct({ "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetWatchesForPage200 = WatchArray
export const GetWatchesForPage200 = WatchArray
export type GetWatchesForSpaceParams = { readonly "start"?: number, readonly "limit"?: number }
export const GetWatchesForSpaceParams = Schema.Struct({ "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetWatchesForSpace200 = SpaceWatchArray
export const GetWatchesForSpace200 = SpaceWatchArray
export type CopyPageHierarchyRequestJson = CopyPageHierarchyRequest
export const CopyPageHierarchyRequestJson = CopyPageHierarchyRequest
export type CopyPageHierarchy202 = LongTask
export const CopyPageHierarchy202 = LongTask
export type CopyPageParams = { readonly "expand"?: ReadonlyArray<string> }
export const CopyPageParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.String)) })
export type CopyPageRequestJson = CopyPageRequest
export const CopyPageRequestJson = CopyPageRequest
export type CheckContentPermissionRequestJson = ContentPermissionRequest
export const CheckContentPermissionRequestJson = ContentPermissionRequest
export type CheckContentPermission200 = PermissionCheckResponse
export const CheckContentPermission200 = PermissionCheckResponse
export type GetRestrictionsParams = { readonly "expand"?: ReadonlyArray<"restrictions.user" | "read.restrictions.user" | "update.restrictions.user" | "restrictions.group" | "read.restrictions.group" | "update.restrictions.group" | "content">, readonly "start"?: number, readonly "limit"?: number }
export const GetRestrictionsParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["restrictions.user", "read.restrictions.user", "update.restrictions.user", "restrictions.group", "read.restrictions.group", "update.restrictions.group", "content"]))), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetRestrictions200 = ContentRestrictionArray
export const GetRestrictions200 = ContentRestrictionArray
export type UpdateRestrictionsParams = { readonly "expand"?: ReadonlyArray<"restrictions.user" | "read.restrictions.user" | "update.restrictions.user" | "restrictions.group" | "read.restrictions.group" | "update.restrictions.group" | "content"> }
export const UpdateRestrictionsParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["restrictions.user", "read.restrictions.user", "update.restrictions.user", "restrictions.group", "read.restrictions.group", "update.restrictions.group", "content"]))) })
export type UpdateRestrictionsRequestJson = ContentRestrictionAddOrUpdateArray
export const UpdateRestrictionsRequestJson = ContentRestrictionAddOrUpdateArray
export type UpdateRestrictions200 = ContentRestrictionArray
export const UpdateRestrictions200 = ContentRestrictionArray
export type AddRestrictionsParams = { readonly "expand"?: ReadonlyArray<"restrictions.user" | "read.restrictions.user" | "update.restrictions.user" | "restrictions.group" | "read.restrictions.group" | "update.restrictions.group" | "content"> }
export const AddRestrictionsParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["restrictions.user", "read.restrictions.user", "update.restrictions.user", "restrictions.group", "read.restrictions.group", "update.restrictions.group", "content"]))) })
export type AddRestrictionsRequestJson = ContentRestrictionAddOrUpdateArray
export const AddRestrictionsRequestJson = ContentRestrictionAddOrUpdateArray
export type AddRestrictions200 = ContentRestrictionArray
export const AddRestrictions200 = ContentRestrictionArray
export type DeleteRestrictionsParams = { readonly "expand"?: ReadonlyArray<"restrictions.user" | "read.restrictions.user" | "update.restrictions.user" | "restrictions.group" | "read.restrictions.group" | "update.restrictions.group" | "content"> }
export const DeleteRestrictionsParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["restrictions.user", "read.restrictions.user", "update.restrictions.user", "restrictions.group", "read.restrictions.group", "update.restrictions.group", "content"]))) })
export type DeleteRestrictions200 = ContentRestrictionArray
export const DeleteRestrictions200 = ContentRestrictionArray
export type GetRestrictionsByOperationParams = { readonly "expand"?: ReadonlyArray<"restrictions.user" | "restrictions.group" | "content"> }
export const GetRestrictionsByOperationParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["restrictions.user", "restrictions.group", "content"]))) })
export type GetRestrictionsByOperation200 = { readonly [x: string]: { readonly "operationType"?: ContentRestriction, readonly "_links"?: GenericLinks, readonly [x: string]: Schema.Json } }
export const GetRestrictionsByOperation200 = Schema.Record(Schema.String, Schema.StructWithRest(Schema.Struct({ "operationType": Schema.optionalKey(ContentRestriction), "_links": Schema.optionalKey(GenericLinks) }), [Schema.Record(Schema.String, Schema.Json)]))
export type GetRestrictionsForOperationParams = { readonly "expand"?: ReadonlyArray<"restrictions.user" | "restrictions.group" | "content">, readonly "start"?: number, readonly "limit"?: number }
export const GetRestrictionsForOperationParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["restrictions.user", "restrictions.group", "content"]))), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetRestrictionsForOperation200 = ContentRestriction
export const GetRestrictionsForOperation200 = ContentRestriction
export type GetContentRestrictionStatusForUserParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const GetContentRestrictionStatusForUserParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type AddUserToContentRestrictionParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const AddUserToContentRestrictionParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type RemoveUserFromContentRestrictionParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const RemoveUserFromContentRestrictionParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type GetContentStateParams = { readonly "status"?: "current" | "draft" | "archived" }
export const GetContentStateParams = Schema.Struct({ "status": Schema.optionalKey(Schema.Literals(["current", "draft", "archived"])) })
export type GetContentState200 = ContentStateResponse
export const GetContentState200 = ContentStateResponse
export type SetContentStateParams = { readonly "status": "current" | "draft" }
export const SetContentStateParams = Schema.Struct({ "status": Schema.Literals(["current", "draft"]) })
export type SetContentStateRequestJson = ContentStateRestInput
export const SetContentStateRequestJson = ContentStateRestInput
export type SetContentState200 = ContentStateResponse
export const SetContentState200 = ContentStateResponse
export type RemoveContentStateParams = { readonly "status"?: "current" | "draft" }
export const RemoveContentStateParams = Schema.Struct({ "status": Schema.optionalKey(Schema.Literals(["current", "draft"])) })
export type RemoveContentState200 = ContentStateResponse
export const RemoveContentState200 = ContentStateResponse
export type GetAvailableContentStates200 = AvailableContentStates
export const GetAvailableContentStates200 = AvailableContentStates
export type RestoreContentVersionParams = { readonly "expand"?: ReadonlyArray<string> }
export const RestoreContentVersionParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.String)) })
export type RestoreContentVersionRequestJson = VersionRestore
export const RestoreContentVersionRequestJson = VersionRestore
export type RestoreContentVersion200 = Version
export const RestoreContentVersion200 = Version
export type GetCustomContentStates200 = ReadonlyArray<ContentState>
export const GetCustomContentStates200 = Schema.Array(ContentState)
export type AsyncConvertContentBodyRequestParams = { readonly "expand"?: ReadonlyArray<string>, readonly "spaceKeyContext"?: string, readonly "contentIdContext"?: string, readonly "allowCache"?: boolean, readonly "embeddedContentRender"?: "current" | "version-at-save" }
export const AsyncConvertContentBodyRequestParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.String)), "spaceKeyContext": Schema.optionalKey(Schema.String), "contentIdContext": Schema.optionalKey(Schema.String), "allowCache": Schema.optionalKey(Schema.Boolean), "embeddedContentRender": Schema.optionalKey(Schema.Literals(["current", "version-at-save"])) })
export type AsyncConvertContentBodyRequestRequestJson = ContentBodyCreate
export const AsyncConvertContentBodyRequestRequestJson = ContentBodyCreate
export type AsyncConvertContentBodyRequest200 = AsyncId
export const AsyncConvertContentBodyRequest200 = AsyncId
export type AsyncConvertContentBodyResponse200 = AsyncContentBody
export const AsyncConvertContentBodyResponse200 = AsyncContentBody
export type BulkAsyncConvertContentBodyResponseParams = { readonly "ids": ReadonlyArray<string> }
export const BulkAsyncConvertContentBodyResponseParams = Schema.Struct({ "ids": Schema.Array(Schema.String) })
export type BulkAsyncConvertContentBodyResponse200 = AsyncContentBodyArray
export const BulkAsyncConvertContentBodyResponse200 = AsyncContentBodyArray
export type BulkAsyncConvertContentBodyRequestRequestJson = BulkContentBodyConversionInput
export const BulkAsyncConvertContentBodyRequestRequestJson = BulkContentBodyConversionInput
export type BulkAsyncConvertContentBodyRequest200 = AsyncIdArray
export const BulkAsyncConvertContentBodyRequest200 = AsyncIdArray
export type GetAllLabelContentParams = { readonly "name": string, readonly "type"?: "page" | "blogpost" | "attachment" | "page_template", readonly "start"?: number, readonly "limit"?: number }
export const GetAllLabelContentParams = Schema.Struct({ "name": Schema.String, "type": Schema.optionalKey(Schema.Literals(["page", "blogpost", "attachment", "page_template"])), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())) })
export type GetAllLabelContent200 = LabelDetails
export const GetAllLabelContent200 = LabelDetails
export type GetGroupsParams = { readonly "start"?: number, readonly "limit"?: number, readonly "accessType"?: "user" | "admin" | "site-admin" }
export const GetGroupsParams = Schema.Struct({ "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "accessType": Schema.optionalKey(Schema.Literals(["user", "admin", "site-admin"])) })
export type GetGroups200 = GroupArrayWithLinks
export const GetGroups200 = GroupArrayWithLinks
export type CreateGroupRequestJson = GroupName
export const CreateGroupRequestJson = GroupName
export type CreateGroup201 = Group
export const CreateGroup201 = Group
export type GetGroupByGroupIdParams = { readonly "id": string }
export const GetGroupByGroupIdParams = Schema.Struct({ "id": Schema.String })
export type GetGroupByGroupId200 = Group
export const GetGroupByGroupId200 = Group
export type RemoveGroupByIdParams = { readonly "id": string }
export const RemoveGroupByIdParams = Schema.Struct({ "id": Schema.String })
export type SearchGroupsParams = { readonly "query": string, readonly "start"?: number, readonly "limit"?: number, readonly "shouldReturnTotalSize"?: boolean }
export const SearchGroupsParams = Schema.Struct({ "query": Schema.String, "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "shouldReturnTotalSize": Schema.optionalKey(Schema.Boolean) })
export type SearchGroups200 = GroupArrayWithLinks
export const SearchGroups200 = GroupArrayWithLinks
export type GetGroupMembersByGroupIdParams = { readonly "start"?: number, readonly "limit"?: number, readonly "shouldReturnTotalSize"?: boolean, readonly "expand"?: ReadonlyArray<"operations" | "personalSpace" | "isExternalCollaborator"> }
export const GetGroupMembersByGroupIdParams = Schema.Struct({ "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "shouldReturnTotalSize": Schema.optionalKey(Schema.Boolean), "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["operations", "personalSpace", "isExternalCollaborator"]))) })
export type GetGroupMembersByGroupId200 = UserArray
export const GetGroupMembersByGroupId200 = UserArray
export type AddUserToGroupByGroupIdParams = { readonly "groupId": string }
export const AddUserToGroupByGroupIdParams = Schema.Struct({ "groupId": Schema.String })
export type AddUserToGroupByGroupIdRequestJson = AccountId
export const AddUserToGroupByGroupIdRequestJson = AccountId
export type RemoveMemberFromGroupByGroupIdParams = { readonly "groupId": string, readonly "accountId": string, readonly "key"?: string, readonly "username"?: string }
export const RemoveMemberFromGroupByGroupIdParams = Schema.Struct({ "groupId": Schema.String, "accountId": Schema.String, "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String) })
export type GetTasksParams = { readonly "key"?: string, readonly "start"?: number, readonly "limit"?: number }
export const GetTasksParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetTasks200 = LongTaskStatusArray
export const GetTasks200 = LongTaskStatusArray
export type GetTask200 = LongTaskStatusWithLinks
export const GetTask200 = LongTaskStatusWithLinks
export type FindTargetFromSourceParams = { readonly "sourceStatus"?: string, readonly "targetStatus"?: string, readonly "sourceVersion"?: number, readonly "targetVersion"?: number, readonly "expand"?: ReadonlyArray<"relationData" | "source" | "target">, readonly "start"?: number, readonly "limit"?: number }
export const FindTargetFromSourceParams = Schema.Struct({ "sourceStatus": Schema.optionalKey(Schema.String), "targetStatus": Schema.optionalKey(Schema.String), "sourceVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "targetVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["relationData", "source", "target"]))), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type FindTargetFromSource200 = RelationArray
export const FindTargetFromSource200 = RelationArray
export type GetRelationshipParams = { readonly "sourceStatus"?: string, readonly "targetStatus"?: string, readonly "sourceVersion"?: number, readonly "targetVersion"?: number, readonly "expand"?: ReadonlyArray<"relationData" | "source" | "target"> }
export const GetRelationshipParams = Schema.Struct({ "sourceStatus": Schema.optionalKey(Schema.String), "targetStatus": Schema.optionalKey(Schema.String), "sourceVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "targetVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["relationData", "source", "target"]))) })
export type GetRelationship200 = Relation
export const GetRelationship200 = Relation
export type CreateRelationshipParams = { readonly "sourceStatus"?: string, readonly "targetStatus"?: string, readonly "sourceVersion"?: number, readonly "targetVersion"?: number }
export const CreateRelationshipParams = Schema.Struct({ "sourceStatus": Schema.optionalKey(Schema.String), "targetStatus": Schema.optionalKey(Schema.String), "sourceVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "targetVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())) })
export type CreateRelationship200 = Relation
export const CreateRelationship200 = Relation
export type DeleteRelationshipParams = { readonly "sourceStatus"?: string, readonly "targetStatus"?: string, readonly "sourceVersion"?: number, readonly "targetVersion"?: number }
export const DeleteRelationshipParams = Schema.Struct({ "sourceStatus": Schema.optionalKey(Schema.String), "targetStatus": Schema.optionalKey(Schema.String), "sourceVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "targetVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())) })
export type FindSourcesForTargetParams = { readonly "sourceStatus"?: string, readonly "targetStatus"?: string, readonly "sourceVersion"?: number, readonly "targetVersion"?: number, readonly "expand"?: ReadonlyArray<"relationData" | "source" | "target">, readonly "start"?: number, readonly "limit"?: number }
export const FindSourcesForTargetParams = Schema.Struct({ "sourceStatus": Schema.optionalKey(Schema.String), "targetStatus": Schema.optionalKey(Schema.String), "sourceVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "targetVersion": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["relationData", "source", "target"]))), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type FindSourcesForTarget200 = RelationArray
export const FindSourcesForTarget200 = RelationArray
export type SearchByCQLParams = { readonly "cql": string, readonly "cqlcontext"?: string, readonly "cursor"?: string, readonly "next"?: boolean, readonly "prev"?: boolean, readonly "limit"?: number, readonly "start"?: number, readonly "includeArchivedSpaces"?: boolean, readonly "excludeCurrentSpaces"?: boolean, readonly "excerpt"?: "highlight" | "indexed" | "none" | "highlight_unescaped" | "indexed_unescaped", readonly "sitePermissionTypeFilter"?: "all" | "externalCollaborator" | "none", readonly "_"?: number, readonly "expand"?: ReadonlyArray<string> }
export const SearchByCQLParams = Schema.Struct({ "cql": Schema.String, "cqlcontext": Schema.optionalKey(Schema.String), "cursor": Schema.optionalKey(Schema.String), "next": Schema.optionalKey(Schema.Boolean), "prev": Schema.optionalKey(Schema.Boolean), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "includeArchivedSpaces": Schema.optionalKey(Schema.Boolean), "excludeCurrentSpaces": Schema.optionalKey(Schema.Boolean), "excerpt": Schema.optionalKey(Schema.Literals(["highlight", "indexed", "none", "highlight_unescaped", "indexed_unescaped"])), "sitePermissionTypeFilter": Schema.optionalKey(Schema.Literals(["all", "externalCollaborator", "none"])), "_": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "expand": Schema.optionalKey(Schema.Array(Schema.String)) })
export type SearchByCQL200 = SearchPageResponseSearchResult
export const SearchByCQL200 = SearchPageResponseSearchResult
export type SearchUserParams = { readonly "cql": string, readonly "start"?: number, readonly "limit"?: number, readonly "expand"?: ReadonlyArray<string>, readonly "sitePermissionTypeFilter"?: "all" | "externalCollaborator" | "none" }
export const SearchUserParams = Schema.Struct({ "cql": Schema.String, "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "expand": Schema.optionalKey(Schema.Array(Schema.String)), "sitePermissionTypeFilter": Schema.optionalKey(Schema.Literals(["all", "externalCollaborator", "none"])) })
export type SearchUser200 = SearchPageResponseSearchResult
export const SearchUser200 = SearchPageResponseSearchResult
export type GetLookAndFeelSettingsParams = { readonly "spaceKey"?: string }
export const GetLookAndFeelSettingsParams = Schema.Struct({ "spaceKey": Schema.optionalKey(Schema.String) })
export type GetLookAndFeelSettings200 = LookAndFeelSettings
export const GetLookAndFeelSettings200 = LookAndFeelSettings
export type UpdateLookAndFeelRequestJson = LookAndFeelSelection
export const UpdateLookAndFeelRequestJson = LookAndFeelSelection
export type UpdateLookAndFeel200 = LookAndFeelSelection
export const UpdateLookAndFeel200 = LookAndFeelSelection
export type UpdateLookAndFeelSettingsParams = { readonly "spaceKey"?: string }
export const UpdateLookAndFeelSettingsParams = Schema.Struct({ "spaceKey": Schema.optionalKey(Schema.String) })
export type UpdateLookAndFeelSettingsRequestJson = LookAndFeel
export const UpdateLookAndFeelSettingsRequestJson = LookAndFeel
export type UpdateLookAndFeelSettings200 = LookAndFeelWithLinks
export const UpdateLookAndFeelSettings200 = LookAndFeelWithLinks
export type ResetLookAndFeelSettingsParams = { readonly "spaceKey"?: string }
export const ResetLookAndFeelSettingsParams = Schema.Struct({ "spaceKey": Schema.optionalKey(Schema.String) })
export type GetSystemInfo200 = SystemInfoEntity
export const GetSystemInfo200 = SystemInfoEntity
export type GetThemesParams = { readonly "start"?: number, readonly "limit"?: number }
export const GetThemesParams = Schema.Struct({ "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetThemes200 = ThemeArray
export const GetThemes200 = ThemeArray
export type GetGlobalTheme200 = Theme
export const GetGlobalTheme200 = Theme
export type GetTheme200 = Theme
export const GetTheme200 = Theme
export type CreateSpaceRequestJson = SpaceCreate
export const CreateSpaceRequestJson = SpaceCreate
export type CreateSpace200 = Space
export const CreateSpace200 = Space
export type CreatePrivateSpaceRequestJson = SpaceCreate
export const CreatePrivateSpaceRequestJson = SpaceCreate
export type CreatePrivateSpace200 = Space
export const CreatePrivateSpace200 = Space
export type UpdateSpaceRequestJson = SpaceUpdate
export const UpdateSpaceRequestJson = SpaceUpdate
export type UpdateSpace200 = Space
export const UpdateSpace200 = Space
export type DeleteSpace202 = LongTask
export const DeleteSpace202 = LongTask
export type AddPermissionToSpaceRequestJson = SpacePermissionRequest
export const AddPermissionToSpaceRequestJson = SpacePermissionRequest
export type AddPermissionToSpace200 = SpacePermissionV2
export const AddPermissionToSpace200 = SpacePermissionV2
export type AddCustomContentPermissionsRequestJson = SpacePermissionCustomContent
export const AddCustomContentPermissionsRequestJson = SpacePermissionCustomContent
export type GetSpaceSettings200 = SpaceSettings
export const GetSpaceSettings200 = SpaceSettings
export type UpdateSpaceSettingsRequestJson = SpaceSettingsUpdate
export const UpdateSpaceSettingsRequestJson = SpaceSettingsUpdate
export type UpdateSpaceSettings200 = SpaceSettings
export const UpdateSpaceSettings200 = SpaceSettings
export type GetSpaceContentStates200 = ReadonlyArray<ContentState>
export const GetSpaceContentStates200 = Schema.Array(ContentState).annotate({ "description": "Space suggested content states that users can choose from" })
export type GetContentStateSettings200 = ContentStateSettings
export const GetContentStateSettings200 = ContentStateSettings
export type GetContentsWithStateParams = { readonly "state-id": number, readonly "expand"?: ReadonlyArray<string>, readonly "limit"?: number, readonly "start"?: number }
export const GetContentsWithStateParams = Schema.Struct({ "state-id": Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()), "expand": Schema.optionalKey(Schema.Array(Schema.String)), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100))), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetContentsWithState200 = ContentArray
export const GetContentsWithState200 = ContentArray
export type GetSpaceTheme200 = Theme
export const GetSpaceTheme200 = Theme
export type SetSpaceThemeRequestJson = ThemeUpdate
export const SetSpaceThemeRequestJson = ThemeUpdate
export type SetSpaceTheme200 = Theme
export const SetSpaceTheme200 = Theme
export type GetWatchersForSpaceParams = { readonly "start"?: string, readonly "limit"?: string }
export const GetWatchersForSpaceParams = Schema.Struct({ "start": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.String) })
export type GetWatchersForSpace200 = SpaceWatchArray
export const GetWatchersForSpace200 = SpaceWatchArray
export type GetLabelsForSpaceParams = { readonly "prefix"?: "global" | "my" | "team", readonly "start"?: number, readonly "limit"?: number }
export const GetLabelsForSpaceParams = Schema.Struct({ "prefix": Schema.optionalKey(Schema.Literals(["global", "my", "team"])), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetLabelsForSpace200 = LabelArray
export const GetLabelsForSpace200 = LabelArray
export type AddLabelsToSpaceRequestJson = ReadonlyArray<LabelCreate>
export const AddLabelsToSpaceRequestJson = Schema.Array(LabelCreate)
export type AddLabelsToSpace200 = LabelArray
export const AddLabelsToSpace200 = LabelArray
export type DeleteLabelFromSpaceParams = { readonly "name": string, readonly "prefix"?: string }
export const DeleteLabelFromSpaceParams = Schema.Struct({ "name": Schema.String, "prefix": Schema.optionalKey(Schema.String) })
export type UpdateContentTemplateRequestJson = ContentTemplateUpdate
export const UpdateContentTemplateRequestJson = ContentTemplateUpdate
export type UpdateContentTemplate200 = ContentTemplate
export const UpdateContentTemplate200 = ContentTemplate
export type CreateContentTemplateRequestJson = ContentTemplateCreate
export const CreateContentTemplateRequestJson = ContentTemplateCreate
export type CreateContentTemplate200 = ContentTemplate
export const CreateContentTemplate200 = ContentTemplate
export type GetBlueprintTemplatesParams = { readonly "spaceKey"?: string, readonly "start"?: number, readonly "limit"?: number, readonly "expand"?: ReadonlyArray<"body" | "body.storage"> }
export const GetBlueprintTemplatesParams = Schema.Struct({ "spaceKey": Schema.optionalKey(Schema.String), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["body", "body.storage"]))) })
export type GetBlueprintTemplates200 = BlueprintTemplateArray
export const GetBlueprintTemplates200 = BlueprintTemplateArray
export type GetContentTemplatesParams = { readonly "spaceKey"?: string, readonly "start"?: number, readonly "limit"?: number, readonly "expand"?: ReadonlyArray<"body" | "body.storage"> }
export const GetContentTemplatesParams = Schema.Struct({ "spaceKey": Schema.optionalKey(Schema.String), "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["body", "body.storage"]))) })
export type GetContentTemplates200 = ContentTemplateArray
export const GetContentTemplates200 = ContentTemplateArray
export type GetContentTemplateParams = { readonly "expand"?: ReadonlyArray<"body" | "body.storage"> }
export const GetContentTemplateParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["body", "body.storage"]))) })
export type GetContentTemplate200 = ContentTemplate
export const GetContentTemplate200 = ContentTemplate
export type GetUserParams = { readonly "accountId": string, readonly "expand"?: ReadonlyArray<"operations" | "personalSpace" | "isExternalCollaborator"> }
export const GetUserParams = Schema.Struct({ "accountId": Schema.String, "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["operations", "personalSpace", "isExternalCollaborator"]))) })
export type GetUser200 = User
export const GetUser200 = User
export type GetAnonymousUserParams = { readonly "expand"?: ReadonlyArray<"operations"> }
export const GetAnonymousUserParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literal("operations"))) })
export type GetAnonymousUser200 = UserAnonymous
export const GetAnonymousUser200 = UserAnonymous
export type GetCurrentUserParams = { readonly "expand"?: ReadonlyArray<"operations" | "personalSpace" | "isExternalCollaborator"> }
export const GetCurrentUserParams = Schema.Struct({ "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["operations", "personalSpace", "isExternalCollaborator"]))) })
export type GetCurrentUser200 = User
export const GetCurrentUser200 = User
export type GetGroupMembershipsForUserParams = { readonly "accountId": string, readonly "start"?: number, readonly "limit"?: number }
export const GetGroupMembershipsForUserParams = Schema.Struct({ "accountId": Schema.String, "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))) })
export type GetGroupMembershipsForUser200 = GroupArrayWithLinks
export const GetGroupMembershipsForUser200 = GroupArrayWithLinks
export type GetBulkUserLookupParams = { readonly "accountId": string, readonly "expand"?: ReadonlyArray<"operations" | "personalSpace" | "isExternalCollaborator"> }
export const GetBulkUserLookupParams = Schema.Struct({ "accountId": Schema.String, "expand": Schema.optionalKey(Schema.Array(Schema.Literals(["operations", "personalSpace", "isExternalCollaborator"]))) })
export type GetBulkUserLookup200 = BulkUserLookupArray
export const GetBulkUserLookup200 = BulkUserLookupArray
export type GetContentWatchStatusParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const GetContentWatchStatusParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type GetContentWatchStatus200 = UserWatch
export const GetContentWatchStatus200 = UserWatch
export type AddContentWatcherParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const AddContentWatcherParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type RemoveContentWatcherParams = { readonly "X-Atlassian-Token": string, readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const RemoveContentWatcherParams = Schema.Struct({ "X-Atlassian-Token": Schema.String, "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type IsWatchingLabelParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const IsWatchingLabelParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type IsWatchingLabel200 = UserWatch
export const IsWatchingLabel200 = UserWatch
export type AddLabelWatcherParams = { readonly "X-Atlassian-Token": string, readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const AddLabelWatcherParams = Schema.Struct({ "X-Atlassian-Token": Schema.String, "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type RemoveLabelWatcherParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const RemoveLabelWatcherParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type IsWatchingSpaceParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const IsWatchingSpaceParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type IsWatchingSpace200 = UserWatch
export const IsWatchingSpace200 = UserWatch
export type AddSpaceWatcherParams = { readonly "X-Atlassian-Token": string, readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const AddSpaceWatcherParams = Schema.Struct({ "X-Atlassian-Token": Schema.String, "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type RemoveSpaceWatchParams = { readonly "key"?: string, readonly "username"?: string, readonly "accountId"?: string }
export const RemoveSpaceWatchParams = Schema.Struct({ "key": Schema.optionalKey(Schema.String), "username": Schema.optionalKey(Schema.String), "accountId": Schema.optionalKey(Schema.String) })
export type GetPrivacyUnsafeUserEmailParams = { readonly "accountId": string }
export const GetPrivacyUnsafeUserEmailParams = Schema.Struct({ "accountId": Schema.String })
export type GetPrivacyUnsafeUserEmail200 = AccountIdEmailRecord
export const GetPrivacyUnsafeUserEmail200 = AccountIdEmailRecord
export type GetPrivacyUnsafeUserEmailBulkParams = { readonly "accountId": ReadonlyArray<string> }
export const GetPrivacyUnsafeUserEmailBulkParams = Schema.Struct({ "accountId": Schema.Array(Schema.String) })
export type GetPrivacyUnsafeUserEmailBulk200 = AccountIdEmailRecordArray
export const GetPrivacyUnsafeUserEmailBulk200 = AccountIdEmailRecordArray
export type RemoveModulesParams = { readonly "moduleKey": ReadonlyArray<string> }
export const RemoveModulesParams = Schema.Struct({ "moduleKey": Schema.Array(Schema.String) })
export type GetViewsParams = { readonly "fromDate"?: string }
export const GetViewsParams = Schema.Struct({ "fromDate": Schema.optionalKey(Schema.String) })
export type GetViews200 = { readonly "id"?: number, readonly "count"?: number }
export const GetViews200 = Schema.Struct({ "id": Schema.optionalKey(Schema.Number.annotate({ "description": "The content ID." }).check(Schema.isInt())), "count": Schema.optionalKey(Schema.Number.annotate({ "description": "The total number of views for the content." }).check(Schema.isInt())) })
export type GetViewersParams = { readonly "fromDate"?: string }
export const GetViewersParams = Schema.Struct({ "fromDate": Schema.optionalKey(Schema.String) })
export type GetViewers200 = { readonly "id"?: number, readonly "count"?: number }
export const GetViewers200 = Schema.Struct({ "id": Schema.optionalKey(Schema.Number.annotate({ "description": "The content ID." }).check(Schema.isInt())), "count": Schema.optionalKey(Schema.Number.annotate({ "description": "The total number of distinct viewers for the content." }).check(Schema.isInt())) })
export type GetUserPropertiesParams = { readonly "start"?: number, readonly "limit"?: number }
export const GetUserPropertiesParams = Schema.Struct({ "start": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "limit": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(25))) })
export type GetUserProperties200 = UserPropertyKeyArray
export const GetUserProperties200 = UserPropertyKeyArray
export type GetUserProperty200 = UserProperty
export const GetUserProperty200 = UserProperty
export type UpdateUserPropertyRequestJson = UserPropertyUpdate
export const UpdateUserPropertyRequestJson = UserPropertyUpdate
export type CreateUserPropertyRequestJson = UserPropertyCreate
export const CreateUserPropertyRequestJson = UserPropertyCreate

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
): ConfluenceV1Api => {
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
        (cause) => Effect.fail(ConfluenceV1ApiError(tag, cause, response)),
      )
  return {
    httpClient,
    "getAuditRecords": (options) => HttpClientRequest.get(`/wiki/rest/api/audit`).pipe(
    HttpClientRequest.setUrlParams({ "startDate": options?.params?.["startDate"] as any, "endDate": options?.params?.["endDate"] as any, "searchString": options?.params?.["searchString"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAuditRecords200),
      orElse: unexpectedStatus
    }))
  ),
    "createAuditRecord": (options) => HttpClientRequest.post(`/wiki/rest/api/audit`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateAuditRecord200),
      orElse: unexpectedStatus
    }))
  ),
    "exportAuditRecords": (options) => HttpClientRequest.get(`/wiki/rest/api/audit/export`).pipe(
    HttpClientRequest.setUrlParams({ "startDate": options?.params?.["startDate"] as any, "endDate": options?.params?.["endDate"] as any, "searchString": options?.params?.["searchString"] as any, "format": options?.params?.["format"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "getRetentionPeriod": (options) => HttpClientRequest.get(`/wiki/rest/api/audit/retention`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetRetentionPeriod200),
      orElse: unexpectedStatus
    }))
  ),
    "setRetentionPeriod": (options) => HttpClientRequest.put(`/wiki/rest/api/audit/retention`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetRetentionPeriod200),
      orElse: unexpectedStatus
    }))
  ),
    "getAuditRecordsForTimePeriod": (options) => HttpClientRequest.get(`/wiki/rest/api/audit/since`).pipe(
    HttpClientRequest.setUrlParams({ "number": options?.params?.["number"] as any, "units": options?.params?.["units"] as any, "searchString": options?.params?.["searchString"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAuditRecordsForTimePeriod200),
      orElse: unexpectedStatus
    }))
  ),
    "archivePages": (options) => HttpClientRequest.post(`/wiki/rest/api/content/archive`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(ArchivePages202),
      orElse: unexpectedStatus
    }))
  ),
    "publishSharedDraft": (draftId, options) => HttpClientRequest.put(`/wiki/rest/api/content/blueprint/instance/${draftId}`).pipe(
    HttpClientRequest.setUrlParams({ "status": options.params?.["status"] as any, "expand": options.params?.["expand"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PublishSharedDraft200),
      orElse: unexpectedStatus
    }))
  ),
    "publishLegacyDraft": (draftId, options) => HttpClientRequest.post(`/wiki/rest/api/content/blueprint/instance/${draftId}`).pipe(
    HttpClientRequest.setUrlParams({ "status": options.params?.["status"] as any, "expand": options.params?.["expand"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PublishLegacyDraft200),
      orElse: unexpectedStatus
    }))
  ),
    "searchContentByCQL": (options) => HttpClientRequest.get(`/wiki/rest/api/content/search`).pipe(
    HttpClientRequest.setUrlParams({ "cql": options.params["cql"] as any, "cqlcontext": options.params["cqlcontext"] as any, "expand": options.params["expand"] as any, "cursor": options.params["cursor"] as any, "limit": options.params["limit"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SearchContentByCQL200),
      orElse: unexpectedStatus
    }))
  ),
    "deletePageTree": (id, options) => HttpClientRequest.delete(`/wiki/rest/api/content/${id}/pageTree`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeletePageTree202),
      orElse: unexpectedStatus
    }))
  ),
    "movePage": (pageId, position, targetId, options) => HttpClientRequest.put(`/wiki/rest/api/content/${pageId}/move/${position}/${targetId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(MovePage200),
      orElse: unexpectedStatus
    }))
  ),
    "createOrUpdateAttachments": (id, options) => HttpClientRequest.put(`/wiki/rest/api/content/${id}/child/attachment`).pipe(
    HttpClientRequest.setUrlParams({ "status": options.params["status"] as any }),
    HttpClientRequest.setHeaders({ "X-Atlassian-Token": options.params["X-Atlassian-Token"] ?? undefined }),
    HttpClientRequest.bodyFormData(options.payload as any),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateOrUpdateAttachments200),
      orElse: unexpectedStatus
    }))
  ),
    "createAttachment": (id, options) => HttpClientRequest.post(`/wiki/rest/api/content/${id}/child/attachment`).pipe(
    HttpClientRequest.setUrlParams({ "status": options.params?.["status"] as any }),
    HttpClientRequest.bodyFormData(options.payload as any),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateAttachment200),
      orElse: unexpectedStatus
    }))
  ),
    "updateAttachmentProperties": (id, attachmentId, options) => HttpClientRequest.put(`/wiki/rest/api/content/${id}/child/attachment/${attachmentId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateAttachmentProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "updateAttachmentData": (id, attachmentId, options) => HttpClientRequest.post(`/wiki/rest/api/content/${id}/child/attachment/${attachmentId}/data`).pipe(
    HttpClientRequest.bodyFormData(options.payload as any),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateAttachmentData200),
      orElse: unexpectedStatus
    }))
  ),
    "downloadAttatchment": (id, attachmentId, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/child/attachment/${attachmentId}/download`).pipe(
    HttpClientRequest.setUrlParams({ "version": options?.params?.["version"] as any, "status": options?.params?.["status"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "302": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getContentDescendants": (id, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/descendant`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetContentDescendants200),
      orElse: unexpectedStatus
    }))
  ),
    "getDescendantsOfType": (id, type, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/descendant/${type}`).pipe(
    HttpClientRequest.setUrlParams({ "depth": options?.params?.["depth"] as any, "expand": options?.params?.["expand"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDescendantsOfType200),
      orElse: unexpectedStatus
    }))
  ),
    "getMacroBodyByMacroId": (id, version, macroId, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/history/${version}/macro/id/${macroId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetMacroBodyByMacroId200),
      orElse: unexpectedStatus
    }))
  ),
    "getAndConvertMacroBodyByMacroId": (id, version, macroId, to, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/history/${version}/macro/id/${macroId}/convert/${to}`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any, "spaceKeyContext": options?.params?.["spaceKeyContext"] as any, "embeddedContentRender": options?.params?.["embeddedContentRender"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAndConvertMacroBodyByMacroId200),
      orElse: unexpectedStatus
    }))
  ),
    "getAndAsyncConvertMacroBodyByMacroId": (id, version, macroId, to, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/history/${version}/macro/id/${macroId}/convert/async/${to}`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any, "allowCache": options?.params?.["allowCache"] as any, "spaceKeyContext": options?.params?.["spaceKeyContext"] as any, "embeddedContentRender": options?.params?.["embeddedContentRender"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAndAsyncConvertMacroBodyByMacroId200),
      orElse: unexpectedStatus
    }))
  ),
    "addLabelsToContent": (id, options) => HttpClientRequest.post(`/wiki/rest/api/content/${id}/label`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddLabelsToContent200),
      orElse: unexpectedStatus
    }))
  ),
    "removeLabelFromContentUsingQueryParameter": (id, options) => HttpClientRequest.delete(`/wiki/rest/api/content/${id}/label`).pipe(
    HttpClientRequest.setUrlParams({ "name": options.params["name"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removeLabelFromContent": (id, label, options) => HttpClientRequest.delete(`/wiki/rest/api/content/${id}/label/${label}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getWatchesForPage": (id, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/notification/child-created`).pipe(
    HttpClientRequest.setUrlParams({ "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWatchesForPage200),
      orElse: unexpectedStatus
    }))
  ),
    "getWatchesForSpace": (id, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/notification/created`).pipe(
    HttpClientRequest.setUrlParams({ "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWatchesForSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "copyPageHierarchy": (id, options) => HttpClientRequest.post(`/wiki/rest/api/content/${id}/pagehierarchy/copy`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CopyPageHierarchy202),
      orElse: unexpectedStatus
    }))
  ),
    "copyPage": (id, options) => HttpClientRequest.post(`/wiki/rest/api/content/${id}/copy`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options.params?.["expand"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "checkContentPermission": (id, options) => HttpClientRequest.post(`/wiki/rest/api/content/${id}/permission/check`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CheckContentPermission200),
      orElse: unexpectedStatus
    }))
  ),
    "getRestrictions": (id, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/restriction`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetRestrictions200),
      orElse: unexpectedStatus
    }))
  ),
    "updateRestrictions": (id, options) => HttpClientRequest.put(`/wiki/rest/api/content/${id}/restriction`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options.params?.["expand"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateRestrictions200),
      orElse: unexpectedStatus
    }))
  ),
    "addRestrictions": (id, options) => HttpClientRequest.post(`/wiki/rest/api/content/${id}/restriction`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options.params?.["expand"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddRestrictions200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteRestrictions": (id, options) => HttpClientRequest.delete(`/wiki/rest/api/content/${id}/restriction`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteRestrictions200),
      orElse: unexpectedStatus
    }))
  ),
    "getRestrictionsByOperation": (id, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/restriction/byOperation`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetRestrictionsByOperation200),
      orElse: unexpectedStatus
    }))
  ),
    "getRestrictionsForOperation": (id, operationKey, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/restriction/byOperation/${operationKey}`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetRestrictionsForOperation200),
      orElse: unexpectedStatus
    }))
  ),
    "getIndividualGroupRestrictionStatusByGroupId": (id, operationKey, groupId, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/restriction/byOperation/${operationKey}/byGroupId/${groupId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "addGroupToContentRestrictionByGroupId": (id, operationKey, groupId, options) => HttpClientRequest.put(`/wiki/rest/api/content/${id}/restriction/byOperation/${operationKey}/byGroupId/${groupId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removeGroupFromContentRestriction": (id, operationKey, groupId, options) => HttpClientRequest.delete(`/wiki/rest/api/content/${id}/restriction/byOperation/${operationKey}/byGroupId/${groupId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getContentRestrictionStatusForUser": (id, operationKey, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/restriction/byOperation/${operationKey}/user`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "addUserToContentRestriction": (id, operationKey, options) => HttpClientRequest.put(`/wiki/rest/api/content/${id}/restriction/byOperation/${operationKey}/user`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removeUserFromContentRestriction": (id, operationKey, options) => HttpClientRequest.delete(`/wiki/rest/api/content/${id}/restriction/byOperation/${operationKey}/user`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getContentState": (id, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/state`).pipe(
    HttpClientRequest.setUrlParams({ "status": options?.params?.["status"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetContentState200),
      orElse: unexpectedStatus
    }))
  ),
    "setContentState": (id, options) => HttpClientRequest.put(`/wiki/rest/api/content/${id}/state`).pipe(
    HttpClientRequest.setUrlParams({ "status": options.params["status"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetContentState200),
      orElse: unexpectedStatus
    }))
  ),
    "removeContentState": (id, options) => HttpClientRequest.delete(`/wiki/rest/api/content/${id}/state`).pipe(
    HttpClientRequest.setUrlParams({ "status": options?.params?.["status"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(RemoveContentState200),
      orElse: unexpectedStatus
    }))
  ),
    "getAvailableContentStates": (id, options) => HttpClientRequest.get(`/wiki/rest/api/content/${id}/state/available`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAvailableContentStates200),
      orElse: unexpectedStatus
    }))
  ),
    "restoreContentVersion": (id, options) => HttpClientRequest.post(`/wiki/rest/api/content/${id}/version`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options.params?.["expand"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(RestoreContentVersion200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteContentVersion": (id, versionNumber, options) => HttpClientRequest.delete(`/wiki/rest/api/content/${id}/version/${versionNumber}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getCustomContentStates": (options) => HttpClientRequest.get(`/wiki/rest/api/content-states`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomContentStates200),
      orElse: unexpectedStatus
    }))
  ),
    "asyncConvertContentBodyRequest": (to, options) => HttpClientRequest.post(`/wiki/rest/api/contentbody/convert/async/${to}`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options.params?.["expand"] as any, "spaceKeyContext": options.params?.["spaceKeyContext"] as any, "contentIdContext": options.params?.["contentIdContext"] as any, "allowCache": options.params?.["allowCache"] as any, "embeddedContentRender": options.params?.["embeddedContentRender"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AsyncConvertContentBodyRequest200),
      orElse: unexpectedStatus
    }))
  ),
    "asyncConvertContentBodyResponse": (id, options) => HttpClientRequest.get(`/wiki/rest/api/contentbody/convert/async/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AsyncConvertContentBodyResponse200),
      orElse: unexpectedStatus
    }))
  ),
    "bulkAsyncConvertContentBodyResponse": (options) => HttpClientRequest.get(`/wiki/rest/api/contentbody/convert/async/bulk/tasks`).pipe(
    HttpClientRequest.setUrlParams({ "ids": options.params["ids"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(BulkAsyncConvertContentBodyResponse200),
      orElse: unexpectedStatus
    }))
  ),
    "bulkAsyncConvertContentBodyRequest": (options) => HttpClientRequest.post(`/wiki/rest/api/contentbody/convert/async/bulk/tasks`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(BulkAsyncConvertContentBodyRequest200),
      orElse: unexpectedStatus
    }))
  ),
    "getAllLabelContent": (options) => HttpClientRequest.get(`/wiki/rest/api/label`).pipe(
    HttpClientRequest.setUrlParams({ "name": options.params["name"] as any, "type": options.params["type"] as any, "start": options.params["start"] as any, "limit": options.params["limit"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAllLabelContent200),
      orElse: unexpectedStatus
    }))
  ),
    "getGroups": (options) => HttpClientRequest.get(`/wiki/rest/api/group`).pipe(
    HttpClientRequest.setUrlParams({ "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any, "accessType": options?.params?.["accessType"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetGroups200),
      orElse: unexpectedStatus
    }))
  ),
    "createGroup": (options) => HttpClientRequest.post(`/wiki/rest/api/group`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateGroup201),
      orElse: unexpectedStatus
    }))
  ),
    "getGroupByGroupId": (options) => HttpClientRequest.get(`/wiki/rest/api/group/by-id`).pipe(
    HttpClientRequest.setUrlParams({ "id": options.params["id"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetGroupByGroupId200),
      orElse: unexpectedStatus
    }))
  ),
    "removeGroupById": (options) => HttpClientRequest.delete(`/wiki/rest/api/group/by-id`).pipe(
    HttpClientRequest.setUrlParams({ "id": options.params["id"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "searchGroups": (options) => HttpClientRequest.get(`/wiki/rest/api/group/picker`).pipe(
    HttpClientRequest.setUrlParams({ "query": options.params["query"] as any, "start": options.params["start"] as any, "limit": options.params["limit"] as any, "shouldReturnTotalSize": options.params["shouldReturnTotalSize"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SearchGroups200),
      orElse: unexpectedStatus
    }))
  ),
    "getGroupMembersByGroupId": (groupId, options) => HttpClientRequest.get(`/wiki/rest/api/group/${groupId}/membersByGroupId`).pipe(
    HttpClientRequest.setUrlParams({ "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any, "shouldReturnTotalSize": options?.params?.["shouldReturnTotalSize"] as any, "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetGroupMembersByGroupId200),
      orElse: unexpectedStatus
    }))
  ),
    "addUserToGroupByGroupId": (options) => HttpClientRequest.post(`/wiki/rest/api/group/userByGroupId`).pipe(
    HttpClientRequest.setUrlParams({ "groupId": options.params["groupId"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "201": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removeMemberFromGroupByGroupId": (options) => HttpClientRequest.delete(`/wiki/rest/api/group/userByGroupId`).pipe(
    HttpClientRequest.setUrlParams({ "groupId": options.params["groupId"] as any, "accountId": options.params["accountId"] as any, "key": options.params["key"] as any, "username": options.params["username"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getTasks": (options) => HttpClientRequest.get(`/wiki/rest/api/longtask`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTasks200),
      orElse: unexpectedStatus
    }))
  ),
    "getTask": (id, options) => HttpClientRequest.get(`/wiki/rest/api/longtask/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTask200),
      orElse: unexpectedStatus
    }))
  ),
    "findTargetFromSource": (relationName, sourceType, sourceKey, targetType, options) => HttpClientRequest.get(`/wiki/rest/api/relation/${relationName}/from/${sourceType}/${sourceKey}/to/${targetType}`).pipe(
    HttpClientRequest.setUrlParams({ "sourceStatus": options?.params?.["sourceStatus"] as any, "targetStatus": options?.params?.["targetStatus"] as any, "sourceVersion": options?.params?.["sourceVersion"] as any, "targetVersion": options?.params?.["targetVersion"] as any, "expand": options?.params?.["expand"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(FindTargetFromSource200),
      orElse: unexpectedStatus
    }))
  ),
    "getRelationship": (relationName, sourceType, sourceKey, targetType, targetKey, options) => HttpClientRequest.get(`/wiki/rest/api/relation/${relationName}/from/${sourceType}/${sourceKey}/to/${targetType}/${targetKey}`).pipe(
    HttpClientRequest.setUrlParams({ "sourceStatus": options?.params?.["sourceStatus"] as any, "targetStatus": options?.params?.["targetStatus"] as any, "sourceVersion": options?.params?.["sourceVersion"] as any, "targetVersion": options?.params?.["targetVersion"] as any, "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetRelationship200),
      orElse: unexpectedStatus
    }))
  ),
    "createRelationship": (relationName, sourceType, sourceKey, targetType, targetKey, options) => HttpClientRequest.put(`/wiki/rest/api/relation/${relationName}/from/${sourceType}/${sourceKey}/to/${targetType}/${targetKey}`).pipe(
    HttpClientRequest.setUrlParams({ "sourceStatus": options?.params?.["sourceStatus"] as any, "targetStatus": options?.params?.["targetStatus"] as any, "sourceVersion": options?.params?.["sourceVersion"] as any, "targetVersion": options?.params?.["targetVersion"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateRelationship200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteRelationship": (relationName, sourceType, sourceKey, targetType, targetKey, options) => HttpClientRequest.delete(`/wiki/rest/api/relation/${relationName}/from/${sourceType}/${sourceKey}/to/${targetType}/${targetKey}`).pipe(
    HttpClientRequest.setUrlParams({ "sourceStatus": options?.params?.["sourceStatus"] as any, "targetStatus": options?.params?.["targetStatus"] as any, "sourceVersion": options?.params?.["sourceVersion"] as any, "targetVersion": options?.params?.["targetVersion"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "findSourcesForTarget": (relationName, targetType, targetKey, sourceType, options) => HttpClientRequest.get(`/wiki/rest/api/relation/${relationName}/to/${targetType}/${targetKey}/from/${sourceType}`).pipe(
    HttpClientRequest.setUrlParams({ "sourceStatus": options?.params?.["sourceStatus"] as any, "targetStatus": options?.params?.["targetStatus"] as any, "sourceVersion": options?.params?.["sourceVersion"] as any, "targetVersion": options?.params?.["targetVersion"] as any, "expand": options?.params?.["expand"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(FindSourcesForTarget200),
      orElse: unexpectedStatus
    }))
  ),
    "searchByCQL": (options) => HttpClientRequest.get(`/wiki/rest/api/search`).pipe(
    HttpClientRequest.setUrlParams({ "cql": options.params["cql"] as any, "cqlcontext": options.params["cqlcontext"] as any, "cursor": options.params["cursor"] as any, "next": options.params["next"] as any, "prev": options.params["prev"] as any, "limit": options.params["limit"] as any, "start": options.params["start"] as any, "includeArchivedSpaces": options.params["includeArchivedSpaces"] as any, "excludeCurrentSpaces": options.params["excludeCurrentSpaces"] as any, "excerpt": options.params["excerpt"] as any, "sitePermissionTypeFilter": options.params["sitePermissionTypeFilter"] as any, "_": options.params["_"] as any, "expand": options.params["expand"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SearchByCQL200),
      orElse: unexpectedStatus
    }))
  ),
    "searchUser": (options) => HttpClientRequest.get(`/wiki/rest/api/search/user`).pipe(
    HttpClientRequest.setUrlParams({ "cql": options.params["cql"] as any, "start": options.params["start"] as any, "limit": options.params["limit"] as any, "expand": options.params["expand"] as any, "sitePermissionTypeFilter": options.params["sitePermissionTypeFilter"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SearchUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getLookAndFeelSettings": (options) => HttpClientRequest.get(`/wiki/rest/api/settings/lookandfeel`).pipe(
    HttpClientRequest.setUrlParams({ "spaceKey": options?.params?.["spaceKey"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetLookAndFeelSettings200),
      orElse: unexpectedStatus
    }))
  ),
    "updateLookAndFeel": (options) => HttpClientRequest.put(`/wiki/rest/api/settings/lookandfeel`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateLookAndFeel200),
      orElse: unexpectedStatus
    }))
  ),
    "updateLookAndFeelSettings": (options) => HttpClientRequest.post(`/wiki/rest/api/settings/lookandfeel/custom`).pipe(
    HttpClientRequest.setUrlParams({ "spaceKey": options.params?.["spaceKey"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateLookAndFeelSettings200),
      orElse: unexpectedStatus
    }))
  ),
    "resetLookAndFeelSettings": (options) => HttpClientRequest.delete(`/wiki/rest/api/settings/lookandfeel/custom`).pipe(
    HttpClientRequest.setUrlParams({ "spaceKey": options?.params?.["spaceKey"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getSystemInfo": (options) => HttpClientRequest.get(`/wiki/rest/api/settings/systemInfo`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSystemInfo200),
      orElse: unexpectedStatus
    }))
  ),
    "getThemes": (options) => HttpClientRequest.get(`/wiki/rest/api/settings/theme`).pipe(
    HttpClientRequest.setUrlParams({ "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetThemes200),
      orElse: unexpectedStatus
    }))
  ),
    "getGlobalTheme": (options) => HttpClientRequest.get(`/wiki/rest/api/settings/theme/selected`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetGlobalTheme200),
      orElse: unexpectedStatus
    }))
  ),
    "getTheme": (themeKey, options) => HttpClientRequest.get(`/wiki/rest/api/settings/theme/${themeKey}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTheme200),
      orElse: unexpectedStatus
    }))
  ),
    "createSpace": (options) => HttpClientRequest.post(`/wiki/rest/api/space`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "createPrivateSpace": (options) => HttpClientRequest.post(`/wiki/rest/api/space/_private`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreatePrivateSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "updateSpace": (spaceKey, options) => HttpClientRequest.put(`/wiki/rest/api/space/${spaceKey}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteSpace": (spaceKey, options) => HttpClientRequest.delete(`/wiki/rest/api/space/${spaceKey}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteSpace202),
      orElse: unexpectedStatus
    }))
  ),
    "addPermissionToSpace": (spaceKey, options) => HttpClientRequest.post(`/wiki/rest/api/space/${spaceKey}/permission`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddPermissionToSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "addCustomContentPermissions": (spaceKey, options) => HttpClientRequest.post(`/wiki/rest/api/space/${spaceKey}/permission/custom-content`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removePermission": (spaceKey, id, options) => HttpClientRequest.delete(`/wiki/rest/api/space/${spaceKey}/permission/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceSettings": (spaceKey, options) => HttpClientRequest.get(`/wiki/rest/api/space/${spaceKey}/settings`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceSettings200),
      orElse: unexpectedStatus
    }))
  ),
    "updateSpaceSettings": (spaceKey, options) => HttpClientRequest.put(`/wiki/rest/api/space/${spaceKey}/settings`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateSpaceSettings200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceContentStates": (spaceKey, options) => HttpClientRequest.get(`/wiki/rest/api/space/${spaceKey}/state`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceContentStates200),
      orElse: unexpectedStatus
    }))
  ),
    "getContentStateSettings": (spaceKey, options) => HttpClientRequest.get(`/wiki/rest/api/space/${spaceKey}/state/settings`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetContentStateSettings200),
      orElse: unexpectedStatus
    }))
  ),
    "getContentsWithState": (spaceKey, options) => HttpClientRequest.get(`/wiki/rest/api/space/${spaceKey}/state/content`).pipe(
    HttpClientRequest.setUrlParams({ "state-id": options.params["state-id"] as any, "expand": options.params["expand"] as any, "limit": options.params["limit"] as any, "start": options.params["start"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetContentsWithState200),
      orElse: unexpectedStatus
    }))
  ),
    "getSpaceTheme": (spaceKey, options) => HttpClientRequest.get(`/wiki/rest/api/space/${spaceKey}/theme`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetSpaceTheme200),
      orElse: unexpectedStatus
    }))
  ),
    "setSpaceTheme": (spaceKey, options) => HttpClientRequest.put(`/wiki/rest/api/space/${spaceKey}/theme`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetSpaceTheme200),
      orElse: unexpectedStatus
    }))
  ),
    "resetSpaceTheme": (spaceKey, options) => HttpClientRequest.delete(`/wiki/rest/api/space/${spaceKey}/theme`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getWatchersForSpace": (spaceKey, options) => HttpClientRequest.get(`/wiki/rest/api/space/${spaceKey}/watch`).pipe(
    HttpClientRequest.setUrlParams({ "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWatchersForSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "getLabelsForSpace": (spaceKey, options) => HttpClientRequest.get(`/wiki/rest/api/space/${spaceKey}/label`).pipe(
    HttpClientRequest.setUrlParams({ "prefix": options?.params?.["prefix"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetLabelsForSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "addLabelsToSpace": (spaceKey, options) => HttpClientRequest.post(`/wiki/rest/api/space/${spaceKey}/label`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddLabelsToSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteLabelFromSpace": (spaceKey, options) => HttpClientRequest.delete(`/wiki/rest/api/space/${spaceKey}/label`).pipe(
    HttpClientRequest.setUrlParams({ "name": options.params["name"] as any, "prefix": options.params["prefix"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "updateContentTemplate": (options) => HttpClientRequest.put(`/wiki/rest/api/template`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateContentTemplate200),
      orElse: unexpectedStatus
    }))
  ),
    "createContentTemplate": (options) => HttpClientRequest.post(`/wiki/rest/api/template`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateContentTemplate200),
      orElse: unexpectedStatus
    }))
  ),
    "getBlueprintTemplates": (options) => HttpClientRequest.get(`/wiki/rest/api/template/blueprint`).pipe(
    HttpClientRequest.setUrlParams({ "spaceKey": options?.params?.["spaceKey"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any, "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBlueprintTemplates200),
      orElse: unexpectedStatus
    }))
  ),
    "getContentTemplates": (options) => HttpClientRequest.get(`/wiki/rest/api/template/page`).pipe(
    HttpClientRequest.setUrlParams({ "spaceKey": options?.params?.["spaceKey"] as any, "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any, "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetContentTemplates200),
      orElse: unexpectedStatus
    }))
  ),
    "getContentTemplate": (contentTemplateId, options) => HttpClientRequest.get(`/wiki/rest/api/template/${contentTemplateId}`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetContentTemplate200),
      orElse: unexpectedStatus
    }))
  ),
    "removeTemplate": (contentTemplateId, options) => HttpClientRequest.delete(`/wiki/rest/api/template/${contentTemplateId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getUser": (options) => HttpClientRequest.get(`/wiki/rest/api/user`).pipe(
    HttpClientRequest.setUrlParams({ "accountId": options.params["accountId"] as any, "expand": options.params["expand"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getAnonymousUser": (options) => HttpClientRequest.get(`/wiki/rest/api/user/anonymous`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAnonymousUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getCurrentUser": (options) => HttpClientRequest.get(`/wiki/rest/api/user/current`).pipe(
    HttpClientRequest.setUrlParams({ "expand": options?.params?.["expand"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCurrentUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getGroupMembershipsForUser": (options) => HttpClientRequest.get(`/wiki/rest/api/user/memberof`).pipe(
    HttpClientRequest.setUrlParams({ "accountId": options.params["accountId"] as any, "start": options.params["start"] as any, "limit": options.params["limit"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetGroupMembershipsForUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getBulkUserLookup": (options) => HttpClientRequest.get(`/wiki/rest/api/user/bulk`).pipe(
    HttpClientRequest.setUrlParams({ "accountId": options.params["accountId"] as any, "expand": options.params["expand"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetBulkUserLookup200),
      orElse: unexpectedStatus
    }))
  ),
    "getContentWatchStatus": (contentId, options) => HttpClientRequest.get(`/wiki/rest/api/user/watch/content/${contentId}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetContentWatchStatus200),
      orElse: unexpectedStatus
    }))
  ),
    "addContentWatcher": (contentId, options) => HttpClientRequest.post(`/wiki/rest/api/user/watch/content/${contentId}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removeContentWatcher": (contentId, options) => HttpClientRequest.delete(`/wiki/rest/api/user/watch/content/${contentId}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options.params["key"] as any, "username": options.params["username"] as any, "accountId": options.params["accountId"] as any }),
    HttpClientRequest.setHeaders({ "X-Atlassian-Token": options.params["X-Atlassian-Token"] ?? undefined }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "isWatchingLabel": (labelName, options) => HttpClientRequest.get(`/wiki/rest/api/user/watch/label/${labelName}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(IsWatchingLabel200),
      orElse: unexpectedStatus
    }))
  ),
    "addLabelWatcher": (labelName, options) => HttpClientRequest.post(`/wiki/rest/api/user/watch/label/${labelName}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options.params["key"] as any, "username": options.params["username"] as any, "accountId": options.params["accountId"] as any }),
    HttpClientRequest.setHeaders({ "X-Atlassian-Token": options.params["X-Atlassian-Token"] ?? undefined }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removeLabelWatcher": (labelName, options) => HttpClientRequest.delete(`/wiki/rest/api/user/watch/label/${labelName}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "isWatchingSpace": (spaceKey, options) => HttpClientRequest.get(`/wiki/rest/api/user/watch/space/${spaceKey}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(IsWatchingSpace200),
      orElse: unexpectedStatus
    }))
  ),
    "addSpaceWatcher": (spaceKey, options) => HttpClientRequest.post(`/wiki/rest/api/user/watch/space/${spaceKey}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options.params["key"] as any, "username": options.params["username"] as any, "accountId": options.params["accountId"] as any }),
    HttpClientRequest.setHeaders({ "X-Atlassian-Token": options.params["X-Atlassian-Token"] ?? undefined }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removeSpaceWatch": (spaceKey, options) => HttpClientRequest.delete(`/wiki/rest/api/user/watch/space/${spaceKey}`).pipe(
    HttpClientRequest.setUrlParams({ "key": options?.params?.["key"] as any, "username": options?.params?.["username"] as any, "accountId": options?.params?.["accountId"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getPrivacyUnsafeUserEmail": (options) => HttpClientRequest.get(`/wiki/rest/api/user/email`).pipe(
    HttpClientRequest.setUrlParams({ "accountId": options.params["accountId"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPrivacyUnsafeUserEmail200),
      orElse: unexpectedStatus
    }))
  ),
    "getPrivacyUnsafeUserEmailBulk": (options) => HttpClientRequest.get(`/wiki/rest/api/user/email/bulk`).pipe(
    HttpClientRequest.setUrlParams({ "accountId": options.params["accountId"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPrivacyUnsafeUserEmailBulk200),
      orElse: unexpectedStatus
    }))
  ),
    "getModules": (options) => HttpClientRequest.get(`/wiki/rest/atlassian-connect/1/app/module/dynamic`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "registerModules": (options) => HttpClientRequest.post(`/wiki/rest/atlassian-connect/1/app/module/dynamic`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "removeModules": (options) => HttpClientRequest.delete(`/wiki/rest/atlassian-connect/1/app/module/dynamic`).pipe(
    HttpClientRequest.setUrlParams({ "moduleKey": options.params["moduleKey"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getViews": (contentId, options) => HttpClientRequest.get(`/wiki/rest/api/analytics/content/${contentId}/views`).pipe(
    HttpClientRequest.setUrlParams({ "fromDate": options?.params?.["fromDate"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetViews200),
      orElse: unexpectedStatus
    }))
  ),
    "getViewers": (contentId, options) => HttpClientRequest.get(`/wiki/rest/api/analytics/content/${contentId}/viewers`).pipe(
    HttpClientRequest.setUrlParams({ "fromDate": options?.params?.["fromDate"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetViewers200),
      orElse: unexpectedStatus
    }))
  ),
    "getUserProperties": (userId, options) => HttpClientRequest.get(`/wiki/rest/api/user/${userId}/property`).pipe(
    HttpClientRequest.setUrlParams({ "start": options?.params?.["start"] as any, "limit": options?.params?.["limit"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUserProperties200),
      orElse: unexpectedStatus
    }))
  ),
    "getUserProperty": (userId, key, options) => HttpClientRequest.get(`/wiki/rest/api/user/${userId}/property/${key}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUserProperty200),
      orElse: unexpectedStatus
    }))
  ),
    "updateUserProperty": (userId, key, options) => HttpClientRequest.put(`/wiki/rest/api/user/${userId}/property/${key}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "createUserProperty": (userId, key, options) => HttpClientRequest.post(`/wiki/rest/api/user/${userId}/property/${key}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "201": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "deleteUserProperty": (userId, key, options) => HttpClientRequest.delete(`/wiki/rest/api/user/${userId}/property/${key}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  )
  }
}

export interface ConfluenceV1Api {
  readonly httpClient: HttpClient.HttpClient
  /**
* Returns all records in the audit log, optionally for a certain date range.
* This contains information about events like space exports, group membership
* changes, app installations, etc. For more information, see
* [Audit log](https://confluence.atlassian.com/confcloud/audit-log-802164269.html)
* in the Confluence administrator's guide.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission.
*/
readonly "getAuditRecords": <Config extends OperationConfig>(options: { readonly params?: typeof GetAuditRecordsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAuditRecords200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a record in the audit log.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission.
*/
readonly "createAuditRecord": <Config extends OperationConfig>(options: { readonly payload: typeof CreateAuditRecordRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateAuditRecord200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Exports audit records as a CSV file or ZIP file.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission.
*/
readonly "exportAuditRecords": <Config extends OperationConfig>(options: { readonly params?: typeof ExportAuditRecordsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the retention period for records in the audit log. The retention
* period is how long an audit record is kept for, from creation date until
* it is deleted.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission.
*/
readonly "getRetentionPeriod": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetRetentionPeriod200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Sets the retention period for records in the audit log. The retention period
* can be set to a maximum of 1 year.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission.
*/
readonly "setRetentionPeriod": <Config extends OperationConfig>(options: { readonly payload: typeof SetRetentionPeriodRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetRetentionPeriod200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns records from the audit log, for a time period back from the current
* date. For example, you can use this method to get the last 3 months of records.
*
* This contains information about events like space exports, group membership
* changes, app installations, etc. For more information, see
* [Audit log](https://confluence.atlassian.com/confcloud/audit-log-802164269.html)
* in the Confluence administrator's guide.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission.
*/
readonly "getAuditRecordsForTimePeriod": <Config extends OperationConfig>(options: { readonly params?: typeof GetAuditRecordsForTimePeriodParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAuditRecordsForTimePeriod200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Archives a list of pages. The pages to be archived are specified as a list of content IDs.
* This API accepts the archival request and returns a task ID.
* The archival process happens asynchronously.
* Use the /longtask/<taskId> REST API to get the copy task status.
*
* Each content ID needs to resolve to page objects that are not already in an archived state.
* The content IDs need not belong to the same space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Archive' permission for each of the pages in the corresponding space it belongs to.
*/
readonly "archivePages": <Config extends OperationConfig>(options: { readonly payload: typeof ArchivePagesRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof ArchivePages202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Publishes a shared draft of a page created from a blueprint.
*
* By default, the following objects are expanded: `body.storage`, `history`, `space`, `version`, `ancestors`.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the draft and 'Add' permission for the space that
* the content will be created in.
*/
readonly "publishSharedDraft": <Config extends OperationConfig>(draftId: string, options: { readonly params?: typeof PublishSharedDraftParams.Encoded | undefined; readonly payload: typeof PublishSharedDraftRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PublishSharedDraft200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Publishes a legacy draft of a page created from a blueprint. Legacy drafts
* will eventually be removed in favor of shared drafts. For now, this method
* works the same as [Publish shared draft](#api-content-blueprint-instance-draftId-put).
*
* By default, the following objects are expanded: `body.storage`, `history`, `space`, `version`, `ancestors`.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the draft and 'Add' permission for the space that
* the content will be created in.
*/
readonly "publishLegacyDraft": <Config extends OperationConfig>(draftId: string, options: { readonly params?: typeof PublishLegacyDraftParams.Encoded | undefined; readonly payload: typeof PublishLegacyDraftRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PublishLegacyDraft200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the list of content that matches a Confluence Query Language
* (CQL) query. For information on CQL, see:
* [Advanced searching using CQL](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/).
*
* Example initial call:
* ```
* /wiki/rest/api/content/search?cql=type=page&limit=25
* ```
*
* Example response:
* ```
* {
*   "results": [
*     { ... },
*     { ... },
*     ...
*     { ... }
*   ],
*   "limit": 25,
*   "size": 25,
*   ...
*   "_links": {
*     "base": "<url>",
*     "context": "<url>",
*     "next": "/rest/api/content/search?cql=type=page&limit=25&cursor=raNDoMsTRiNg",
*     "self": "<url>"
*   }
* }
* ```
*
* When additional results are available, returns `next` and `prev` URLs to retrieve them in subsequent calls. The URLs each contain a cursor that points to the appropriate set of results. Use `limit` to specify the number of results returned in each call.
* Example subsequent call (taken from example response):
* ```
* /wiki/rest/api/content/search?cql=type=page&limit=25&cursor=raNDoMsTRiNg
* ```
* The response to this will have a `prev` URL similar to the `next` in the example response.
*
* If the expand query parameter is used with the `body.export_view` and/or `body.styled_view` properties, then the query limit parameter will be restricted to a maximum value of 25.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* Only content that the user has permission to view will be returned.
*/
readonly "searchContentByCQL": <Config extends OperationConfig>(options: { readonly params: typeof SearchContentByCQLParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SearchContentByCQL200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Moves a pagetree rooted at a page to the space's trash:
*
* - If the content's type is `page` and its status is `current`, it will be trashed including
* all its descendants.
* - For every other combination of content type and status, this API is not supported.
*
* This API accepts the pageTree delete request and returns a task ID.
* The delete process happens asynchronously.
*
*  Response example:
*  <pre><code>
*  {
*       "id" : "1180606",
*       "links" : {
*            "status" : "/rest/api/longtask/1180606"
*       }
*  }
*  </code></pre>
*  Use the `/longtask/<taskId>` REST API to get the copy task status.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Delete' permission for the space that the content is in.
*/
readonly "deletePageTree": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeletePageTree202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Move a page to a new location relative to a target page:
*
* * `before` - move the page under the same parent as the target, before the target in the list of children
* * `after` - move the page under the same parent as the target, after the target in the list of children
* * `append` - move the page to be a child of the target
*
* Caution: This API can move pages to the top level of a space. Top-level pages are difficult to find in the UI
* because they do not show up in the page tree display. To avoid this, never use `before` or `after` positions
* when the `targetId` is a top-level page.
*/
readonly "movePage": <Config extends OperationConfig>(pageId: string, position: string, targetId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof MovePage200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds an attachment to a piece of content. If the attachment already exists
* for the content, then the attachment is updated (i.e. a new version of the
* attachment is created).
*
* Note, you must set a `X-Atlassian-Token: nocheck` header on the request
* for this method, otherwise it will be blocked. This protects against XSRF
* attacks, which is necessary as this method accepts multipart/form-data.
*
* The media type 'multipart/form-data' is defined in [RFC 7578](https://www.ietf.org/rfc/rfc7578.txt).
* Most client libraries have classes that make it easier to implement
* multipart posts, like the [MultipartEntityBuilder](https://hc.apache.org/httpcomponents-client-5.1.x/current/httpclient5/apidocs/)
* Java class provided by Apache HTTP Components.
*
* Note, according to [RFC 7578](https://tools.ietf.org/html/rfc7578#section-4.5),
* in the case where the form data is text,
* the charset parameter for the "text/plain" Content-Type may be used to
* indicate the character encoding used in that part. In the case of this
* API endpoint, the `comment` body parameter should be sent with `type=text/plain`
* and `charset=utf-8` values. This will force the charset to be UTF-8.
*
* Example: This curl command attaches a file ('example.txt') to a piece of
* content (id='123') with a comment and `minorEdits`=true. If the 'example.txt'
* file already exists, it will update it with a new version of the attachment.
*
* ``` bash
* curl -D- \
*   -u admin:admin \
*   -X PUT \
*   -H 'X-Atlassian-Token: nocheck' \
*   -F 'file=@"example.txt"' \
*   -F 'minorEdit="true"' \
*   -F 'comment="Example attachment comment"; type=text/plain; charset=utf-8' \
*   http://myhost/rest/api/content/123/child/attachment
* ```
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "createOrUpdateAttachments": <Config extends OperationConfig>(id: string, options: { readonly params: typeof CreateOrUpdateAttachmentsParams.Encoded; readonly payload: typeof CreateOrUpdateAttachmentsRequestFormData.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateOrUpdateAttachments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds an attachment to a piece of content. This method only adds a new
* attachment. If you want to update an existing attachment, use
* [Create or update attachments](#api-content-id-child-attachment-put).
*
* Note, you must set a `X-Atlassian-Token: nocheck` header on the request
* for this method, otherwise it will be blocked. This protects against XSRF
* attacks, which is necessary as this method accepts multipart/form-data.
*
* The media type 'multipart/form-data' is defined in [RFC 7578](https://www.ietf.org/rfc/rfc7578.txt).
* Most client libraries have classes that make it easier to implement
* multipart posts, like the [MultipartEntityBuilder](https://hc.apache.org/httpcomponents-client-5.1.x/current/httpclient5/apidocs/)
* Java class provided by Apache HTTP Components.
*
* Note, according to [RFC 7578](https://tools.ietf.org/html/rfc7578#section-4.5),
* in the case where the form data is text,
* the charset parameter for the "text/plain" Content-Type may be used to
* indicate the character encoding used in that part. In the case of this
* API endpoint, the `comment` body parameter should be sent with `type=text/plain`
* and `charset=utf-8` values. This will force the charset to be UTF-8.
*
* Example: This curl command attaches a file ('example.txt') to a container
* (id='123') with a comment and `minorEdits`=true.
*
* ``` bash
* curl -D- \
*   -u admin:admin \
*   -X POST \
*   -H 'X-Atlassian-Token: nocheck' \
*   -F 'file=@"example.txt"' \
*   -F 'minorEdit="true"' \
*   -F 'comment="Example attachment comment"; type=text/plain; charset=utf-8' \
*   https://myhost/wiki/rest/api/content/123/child/attachment
* ```
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "createAttachment": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof CreateAttachmentParams.Encoded | undefined; readonly payload: typeof CreateAttachmentRequestFormData.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateAttachment200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the attachment properties, i.e. the non-binary data of an attachment
* like the filename, media-type, comment, and parent container.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "updateAttachmentProperties": <Config extends OperationConfig>(id: string, attachmentId: string, options: { readonly payload: typeof UpdateAttachmentPropertiesRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateAttachmentProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the binary data of an attachment, given the attachment ID, and
* optionally the comment and the minor edit field.
*
* This method is essentially the same as [Create or update attachments](#api-content-id-child-attachment-put),
* except that it matches the attachment ID rather than the name.
*
* Note, you must set a `X-Atlassian-Token: nocheck` header on the request
* for this method, otherwise it will be blocked. This protects against XSRF
* attacks, which is necessary as this method accepts multipart/form-data.
*
* The media type 'multipart/form-data' is defined in [RFC 7578](https://www.ietf.org/rfc/rfc7578.txt).
* Most client libraries have classes that make it easier to implement
* multipart posts, like the [MultipartEntityBuilder](https://hc.apache.org/httpcomponents-client-5.1.x/current/httpclient5/apidocs/)
* Java class provided by Apache HTTP Components.
*
* Note, according to [RFC 7578](https://tools.ietf.org/html/rfc7578#section-4.5),
* in the case where the form data is text,
* the charset parameter for the "text/plain" Content-Type may be used to
* indicate the character encoding used in that part. In the case of this
* API endpoint, the `comment` body parameter should be sent with `type=text/plain`
* and `charset=utf-8` values. This will force the charset to be UTF-8.
*
* Example: This curl command updates an attachment (id='att456') that is attached
* to a piece of content (id='123') with a comment and `minorEdits`=true.
*
* ``` bash
* curl -D- \
*   -u admin:admin \
*   -X POST \
*   -H 'X-Atlassian-Token: nocheck' \
*   -F 'file=@"example.txt"' \
*   -F 'minorEdit="true"' \
*   -F 'comment="Example attachment comment"; type=text/plain; charset=utf-8' \
*   http://myhost/rest/api/content/123/child/attachment/att456/data
* ```
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "updateAttachmentData": <Config extends OperationConfig>(id: string, attachmentId: string, options: { readonly payload: typeof UpdateAttachmentDataRequestFormData.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateAttachmentData200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Redirects the client to a URL that serves an attachment's binary data.
*/
readonly "downloadAttatchment": <Config extends OperationConfig>(id: string, attachmentId: string, options: { readonly params?: typeof DownloadAttatchmentParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a map of the descendants of a piece of content. This is similar
* to [Get content children](#api-content-id-child-get), except that this
* method returns child pages at all levels, rather than just the direct
* child pages.
*
* A piece of content has different types of descendants, depending on its type:
*
* - `page`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `whiteboard`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `database`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `embed`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `folder`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `blogpost`: descendant is `comment`, `attachment`
* - `attachment`: descendant is `comment`
* - `comment`: descendant is `attachment`
*
* The map will always include all descendant types that are valid for the content.
* However, if the content has no instances of a descendant type, the map will
* contain an empty array for that descendant type.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space, and permission to view the content if it
* is a page.
*/
readonly "getContentDescendants": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetContentDescendantsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetContentDescendants200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all descendants of a given type, for a piece of content. This is
* similar to [Get content children by type](#api-content-id-child-type-get),
* except that this method returns child pages at all levels, rather than just
* the direct child pages.
*
* A piece of content has different types of descendants, depending on its type:
*
* - `page`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `whiteboard`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `database`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `embed`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `folder`: descendant is `page`, `whiteboard`, `database`, `embed`, `folder`, `comment`, `attachment`
* - `blogpost`: descendant is `comment`, `attachment`
* - `attachment`: descendant is `comment`
* - `comment`: descendant is `attachment`
*
* Custom content types that are provided by apps can also be returned.
*
* If the expand query parameter is used with the `body.export_view` and/or `body.styled_view` properties, then the query limit parameter will be restricted to a maximum value of 25.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space, and permission to view the content if it
* is a page.
*/
readonly "getDescendantsOfType": <Config extends OperationConfig>(id: string, type: string, options: { readonly params?: typeof GetDescendantsOfTypeParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetDescendantsOfType200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the body of a macro in storage format, for the given macro ID.
* This includes information like the name of the macro, the body of the macro,
* and any macro parameters. This method is mainly used by Cloud apps.
*
* About the macro ID: When a macro is created in a new version of content,
* Confluence will generate a random ID for it, unless an ID is specified
* (by an app). The macro ID will look similar to this: '50884bd9-0cb8-41d5-98be-f80943c14f96'.
* The ID is then persisted as new versions of content are created, and is
* only modified by Confluence if there are conflicting IDs.
*
* For Forge macros, the value for macro ID is the "local ID" of that particular ADF node.
* This value can be retrieved either client-side by calling view.getContext() and accessing "localId"
* on the resulting object, or server-side by examining the "local-id" parameter node inside the "parameters" node.
*
* Note that there are other attributes named "local-id", but only this particular one is used to store the macro ID.
*
* Example:
* <ac:adf-node type="extension">
*   <ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute>
*   <ac:adf-attribute key="parameters">
*       <ac:adf-parameter key="local-id">e9c4aa10-73fa-417c-888d-48c719ae4165</ac:adf-parameter>
*   </ac:adf-parameter>
* </ac:adf-node>
*
* Note, to preserve backwards compatibility this resource will also match on
* the hash of the macro body, even if a macro ID is found. This check will
* eventually become redundant, as macro IDs are generated for pages and
* transparently propagate out to all instances.
*
* This backwards compatibility logic does not apply to Forge macros; those
* can only be retrieved by their ID.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content that the macro is in.
*/
readonly "getMacroBodyByMacroId": <Config extends OperationConfig>(id: string, version: string, macroId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetMacroBodyByMacroId200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the body of a macro in format specified in path, for the given macro ID.
* This includes information like the name of the macro, the body of the macro,
* and any macro parameters.
*
* About the macro ID: When a macro is created in a new version of content,
* Confluence will generate a random ID for it, unless an ID is specified
* (by an app). The macro ID will look similar to this: '50884bd9-0cb8-41d5-98be-f80943c14f96'.
* The ID is then persisted as new versions of content are created, and is
* only modified by Confluence if there are conflicting IDs.
*
* For Forge macros, the value for macro ID is the "local ID" of that particular ADF node.
* This value can be retrieved either client-side by calling view.getContext() and accessing "localId"
* on the resulting object, or server-side by examining the "local-id" parameter node inside the "parameters" node.
*
* Note that there are other attributes named "local-id", but only this particular one is used to store the macro ID.
*
* Example:
* <ac:adf-node type="extension">
*   <ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute>
*   <ac:adf-attribute key="parameters">
*       <ac:adf-parameter key="local-id">e9c4aa10-73fa-417c-888d-48c719ae4165</ac:adf-parameter>
*   </ac:adf-parameter>
* </ac:adf-node>
*
* Note, to preserve backwards compatibility this resource will also match on
* the hash of the macro body, even if a macro ID is found. This check will
* eventually become redundant, as macro IDs are generated for pages and
* transparently propagate out to all instances.
*
* This backwards compatibility logic does not apply to Forge macros; those
* can only be retrieved by their ID.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content that the macro is in.
*/
readonly "getAndConvertMacroBodyByMacroId": <Config extends OperationConfig>(id: string, version: string, macroId: string, to: string, options: { readonly params?: typeof GetAndConvertMacroBodyByMacroIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAndConvertMacroBodyByMacroId200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns Async Id of the conversion task which will convert the macro into a content body of the desired format.
* The result will be available for 5 minutes after completion of the conversion.
*
* About the macro ID: When a macro is created in a new version of content,
* Confluence will generate a random ID for it, unless an ID is specified
* (by an app). The macro ID will look similar to this: '884bd9-0cb8-41d5-98be-f80943c14f96'.
* The ID is then persisted as new versions of content are created, and is
* only modified by Confluence if there are conflicting IDs.
*
* For Forge macros, the value for macro ID is the "local ID" of that particular ADF node.
* This value can be retrieved either client-side by calling view.getContext() and accessing "localId"
* on the resulting object, or server-side by examining the "local-id" parameter node inside the "parameters" node.
*
* Note that there are other attributes named "local-id", but only this particular one is used to store the macro ID.
*
* Example:
* <ac:adf-node type="extension">
*   <ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute>
*   <ac:adf-attribute key="parameters">
*       <ac:adf-parameter key="local-id">e9c4aa10-73fa-417c-888d-48c719ae4165</ac:adf-parameter>
*   </ac:adf-parameter>
* </ac:adf-node>
*
* Note, to preserve backwards compatibility this resource will also match on
* the hash of the macro body, even if a macro ID is found. This check will
* eventually become redundant, as macro IDs are generated for pages and
* transparently propagate out to all instances.
*
* This backwards compatibility logic does not apply to Forge macros; those
* can only be retrieved by their ID.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content that the macro is in.
*/
readonly "getAndAsyncConvertMacroBodyByMacroId": <Config extends OperationConfig>(id: string, version: string, macroId: string, to: string, options: { readonly params?: typeof GetAndAsyncConvertMacroBodyByMacroIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAndAsyncConvertMacroBodyByMacroId200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds labels to a piece of content. Does not modify the existing labels.
*
* Notes:
*
* - Labels can also be added when creating content ([Create content](#api-content-post)).
* - Labels can be updated when updating content ([Update content](#api-content-id-put)).
* This will delete the existing labels and replace them with the labels in
* the request.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "addLabelsToContent": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof AddLabelsToContentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddLabelsToContent200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes a label from a piece of content. Labels can't be deleted from archived content.
* This is similar to [Remove label from content](#api-content-id-label-label-delete)
* except that the label name is specified via a query parameter.
*
* Use this method if the label name has "/" characters, as
* [Remove label from content using query parameter](#api-content-id-label-delete)
* does not accept "/" characters for the label name.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "removeLabelFromContentUsingQueryParameter": <Config extends OperationConfig>(id: string, options: { readonly params: typeof RemoveLabelFromContentUsingQueryParameterParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes a label from a piece of content. Labels can't be deleted from archived content.
* This is similar to [Remove label from content using query parameter](#api-content-id-label-delete)
* except that the label name is specified via a path parameter.
*
* Use this method if the label name does not have "/" characters, as the path
* parameter does not accept "/" characters for security reasons. Otherwise,
* use [Remove label from content using query parameter](#api-content-id-label-delete).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "removeLabelFromContent": <Config extends OperationConfig>(id: string, label: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the watches for a page. A user that watches a page will receive
* receive notifications when the page is updated.
*
* If you want to manage watches for a page, use the following `user` methods:
*
* - [Get content watch status for user](#api-user-watch-content-contentId-get)
* - [Add content watch](#api-user-watch-content-contentId-post)
* - [Remove content watch](#api-user-watch-content-contentId-delete)
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getWatchesForPage": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetWatchesForPageParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWatchesForPage200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all space watches for the space that the content is in. A user that
* watches a space will receive receive notifications when any content in the
* space is updated.
*
* If you want to manage watches for a space, use the following `user` methods:
*
* - [Get space watch status for user](#api-user-watch-space-spaceKey-get)
* - [Add space watch](#api-user-watch-space-spaceKey-post)
* - [Remove space watch](#api-user-watch-space-spaceKey-delete)
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getWatchesForSpace": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetWatchesForSpaceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWatchesForSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Copy page hierarchy allows the copying of an entire hierarchy of pages and their associated properties, permissions and attachments.
*  The id path parameter refers to the content id of the page to copy, and the new parent of this copied page is defined using the destinationPageId in the request body.
*  The titleOptions object defines the rules of renaming page titles during the copy;
*  for example, search and replace can be used in conjunction to rewrite the copied page titles.
*
*  Response example:
*  <pre><code>
*  {
*       "id" : "1180606",
*       "links" : {
*            "status" : "/rest/api/longtask/1180606"
*       }
*  }
*  </code></pre>
*  Use the /longtask/<taskId> REST API to get the copy task status.
*/
readonly "copyPageHierarchy": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof CopyPageHierarchyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CopyPageHierarchy202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Copies a single page and its associated properties, permissions, attachments, and custom contents.
*  The `id` path parameter refers to the content ID of the page to copy. The target of the page to be copied
*  is defined using the `destination` in the request body and can be one of the following types.
*
*   - `space`: page will be copied to the specified space as a root page on the space
*   - `parent_page`: page will be copied as a child of the specified parent page
*   - `parent_content`: page will be copied as a child of the specified parent content
*   - `existing_page`: page will be copied and replace the specified page
*
* By default, the following objects are expanded: `space`, `history`, `version`.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**: 'Add' permission for the space that the content will be copied in and permission to update the content if copying to an `existing_page`.
*/
readonly "copyPage": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof CopyPageParams.Encoded | undefined; readonly payload: typeof CopyPageRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Check if a user or a group can perform an operation to the specified content. The `operation` to check
* must be provided. The user’s account ID or the ID of the group can be provided in the `subject` to check
* permissions against a specified user or group. The following permission checks are done to make sure that the
* user or group has the proper access:
*
* - site permissions
* - space permissions
* - content restrictions
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission) if checking permission for self,
* otherwise 'Confluence Administrator' global permission is required.
*/
readonly "checkContentPermission": <Config extends OperationConfig>(id: string, options: { readonly payload: typeof CheckContentPermissionRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CheckContentPermission200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the restrictions on a piece of content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content.
*/
readonly "getRestrictions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetRestrictionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetRestrictions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates restrictions for a piece of content. This removes the existing
* restrictions and replaces them with the restrictions in the request.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "updateRestrictions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof UpdateRestrictionsParams.Encoded | undefined; readonly payload: typeof UpdateRestrictionsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateRestrictions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds restrictions to a piece of content. Note, this does not change any
* existing restrictions on the content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "addRestrictions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof AddRestrictionsParams.Encoded | undefined; readonly payload: typeof AddRestrictionsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddRestrictions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes all restrictions (read and update) on a piece of content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "deleteRestrictions": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof DeleteRestrictionsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteRestrictions200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns restrictions on a piece of content by operation. This method is
* similar to [Get restrictions](#api-content-id-restriction-get) except that
* the operations are properties of the return object, rather than items in
* a results array.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content.
*/
readonly "getRestrictionsByOperation": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetRestrictionsByOperationParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetRestrictionsByOperation200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the restictions on a piece of content for a given operation (read
* or update).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content.
*/
readonly "getRestrictionsForOperation": <Config extends OperationConfig>(id: string, operationKey: string, options: { readonly params?: typeof GetRestrictionsForOperationParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetRestrictionsForOperation200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns whether the specified content restriction applies to a group.
* For example, if a page with `id=123` has a `read` restriction for the `123456` group id,
* the following request will return `true`:
*
* `/wiki/rest/api/content/123/restriction/byOperation/read/byGroupId/123456`
*
* Note that a response of `true` does not guarantee that the group can view the page, as it does not account for
* account-inherited restrictions, space permissions, or even product access. For more
* information, see [Confluence permissions](https://confluence.atlassian.com/x/_AozKw).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content.
*/
readonly "getIndividualGroupRestrictionStatusByGroupId": <Config extends OperationConfig>(id: string, operationKey: string, groupId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds a group to a content restriction by Group Id. That is, grant read or update
* permission to the group for a piece of content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "addGroupToContentRestrictionByGroupId": <Config extends OperationConfig>(id: string, operationKey: string, groupId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes a group from a content restriction. That is, remove read or update
* permission for the group for a piece of content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "removeGroupFromContentRestriction": <Config extends OperationConfig>(id: string, operationKey: string, groupId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns whether the specified content restriction applies to a user.
* For example, if a page with `id=123` has a `read` restriction for a user with an account ID of
* `384093:32b4d9w0-f6a5-3535-11a3-9c8c88d10192`, the following request will return `true`:
*
* `/wiki/rest/api/content/123/restriction/byOperation/read/user?accountId=384093:32b4d9w0-f6a5-3535-11a3-9c8c88d10192`
*
* Note that a response of `true` does not guarantee that the user can view the page, as it does not account for
* account-inherited restrictions, space permissions, or even product access. For more
* information, see [Confluence permissions](https://confluence.atlassian.com/x/_AozKw).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content.
*/
readonly "getContentRestrictionStatusForUser": <Config extends OperationConfig>(id: string, operationKey: string, options: { readonly params?: typeof GetContentRestrictionStatusForUserParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds a user to a content restriction. That is, grant read or update
* permission to the user for a piece of content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "addUserToContentRestriction": <Config extends OperationConfig>(id: string, operationKey: string, options: { readonly params?: typeof AddUserToContentRestrictionParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes a group from a content restriction. That is, remove read or update
* permission for the group for a piece of content.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "removeUserFromContentRestriction": <Config extends OperationConfig>(id: string, operationKey: string, options: { readonly params?: typeof RemoveUserFromContentRestrictionParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Gets the current content state of the draft or current version of content. To specify the draft version, set
* the parameter status to draft, otherwise archived or current will get the relevant published state.
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the content.
*/
readonly "getContentState": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GetContentStateParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetContentState200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Sets the content state of the content specified and creates a new version
* (publishes the content without changing the body) of the content with the new state.
*
* You may pass in either an id of a state, or the name and color of a desired new state.
* If all 3 are passed in, id will be used.
* If the name and color passed in already exist under the current user's existing custom states, the existing state will be reused.
* If custom states are disabled in the space of the content (which can be determined by getting the content state space settings of the content's space)
* then this set will fail.
*
* You may not remove a content state via this PUT request. You must use the DELETE method. A specified state is required in the body of this request.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "setContentState": <Config extends OperationConfig>(id: string, options: { readonly params: typeof SetContentStateParams.Encoded; readonly payload: typeof SetContentStateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetContentState200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes the content state of the content specified and creates a new version
* (publishes the content without changing the body) of the content with the new status.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "removeContentState": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof RemoveContentStateParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof RemoveContentState200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Gets content states that are available for the content to be set as.
* Will return all enabled Space Content States.
* Will only return most the 3 most recently published custom content states to match UI editor list.
* To get all custom content states, use the /content-states endpoint.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to edit the content.
*/
readonly "getAvailableContentStates": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAvailableContentStates200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Restores a historical version to be the latest version. That is, a new version
* is created with the content of the historical version.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "restoreContentVersion": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof RestoreContentVersionParams.Encoded | undefined; readonly payload: typeof RestoreContentVersionRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof RestoreContentVersion200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a historical version. This does not delete the changes made to the
* content in that version, rather the changes for the deleted version are
* rolled up into the next version. Note, you cannot delete the current version.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "deleteContentVersion": <Config extends OperationConfig>(id: string, versionNumber: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get custom content states that authenticated user has created.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**
* Must have user authentication.
*/
readonly "getCustomContentStates": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomContentStates200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Converts a content body from one format to another format asynchronously.
* Returns the asyncId for the asynchronous task.
*
* Supported conversions:
*
* - atlas_doc_format: editor, export_view, storage, styled_view, view
* - storage: atlas_doc_format, editor, export_view, styled_view, view
* - editor: storage
*
* No other conversions are supported at the moment.
* Once a conversion is completed, it will be available for 5 minutes at the result endpoint.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* If request specifies 'contentIdContext', 'View' permission for the space, and permission to view the content.
*/
readonly "asyncConvertContentBodyRequest": <Config extends OperationConfig>(to: string, options: { readonly params?: typeof AsyncConvertContentBodyRequestParams.Encoded | undefined; readonly payload: typeof AsyncConvertContentBodyRequestRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AsyncConvertContentBodyRequest200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the content body for the corresponding `asyncId` of a completed conversion task. If
* the task is not completed, the task status is returned instead.
*
* Once a conversion task is completed, the result can be obtained for up to 5 minutes, or
* until an identical conversion request is made again with the `allowCache` parameter set to
* false.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* If request specifies 'contentIdContext', 'View' permission for the space, and permission to view the content.
*/
readonly "asyncConvertContentBodyResponse": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof AsyncConvertContentBodyResponse200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the content body for the corresponding `asyncId` of a completed conversion task. If
* the task is not completed, the task status is returned instead.
*
* Once a conversion task is completed, the result can be obtained for up to 5 minutes, or
* until an identical conversion request is made again with the `allowCache` parameter set to
* false.
*
* Note that there is a maximum limit of 50 task results per request to this endpoint.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "bulkAsyncConvertContentBodyResponse": <Config extends OperationConfig>(options: { readonly params: typeof BulkAsyncConvertContentBodyResponseParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof BulkAsyncConvertContentBodyResponse200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Asynchronously converts content bodies from one format to another format in bulk. Use the Content body
* REST API to get the status of conversion tasks. Note that there is a maximum limit of 10 conversions per
* request to this endpoint.
*
* Supported conversions:
*
* - storage: editor, export_view, styled_view, view
* - editor: storage
*
* Once a conversion task is completed, it is available for polling for up to 5 minutes.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space, and permission to view the content if the `spaceKeyContext` or
* `contentIdContext` are present.
*/
readonly "bulkAsyncConvertContentBodyRequest": <Config extends OperationConfig>(options: { readonly payload: typeof BulkAsyncConvertContentBodyRequestRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof BulkAsyncConvertContentBodyRequest200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns label information and a list of contents associated with the label.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission). Only contents
* that the user is permitted to view is returned.
*/
readonly "getAllLabelContent": <Config extends OperationConfig>(options: { readonly params: typeof GetAllLabelContentParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetAllLabelContent200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all user groups. The returned groups are ordered alphabetically in
* ascending order by group name.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getGroups": <Config extends OperationConfig>(options: { readonly params?: typeof GetGroupsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetGroups200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new user group.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a site admin.
*/
readonly "createGroup": <Config extends OperationConfig>(options: { readonly payload: typeof CreateGroupRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateGroup201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a user group for a given group id.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getGroupByGroupId": <Config extends OperationConfig>(options: { readonly params: typeof GetGroupByGroupIdParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetGroupByGroupId200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete user group.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a site admin.
*/
readonly "removeGroupById": <Config extends OperationConfig>(options: { readonly params: typeof RemoveGroupByIdParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get search results of groups by partial query provided.
*/
readonly "searchGroups": <Config extends OperationConfig>(options: { readonly params: typeof SearchGroupsParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SearchGroups200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the users that are members of a group.
*
* Use updated Get group API
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getGroupMembersByGroupId": <Config extends OperationConfig>(groupId: string, options: { readonly params?: typeof GetGroupMembersByGroupIdParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetGroupMembersByGroupId200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds a user as a member in a group represented by its groupId
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a site admin.
*/
readonly "addUserToGroupByGroupId": <Config extends OperationConfig>(options: { readonly params: typeof AddUserToGroupByGroupIdParams.Encoded; readonly payload: typeof AddUserToGroupByGroupIdRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Remove user as a member from a group.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* User must be a site admin.
*/
readonly "removeMemberFromGroupByGroupId": <Config extends OperationConfig>(options: { readonly params: typeof RemoveMemberFromGroupByGroupIdParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns information about all active long-running tasks (e.g. space export),
* such as how long each task has been running and the percentage of each task
* that has completed.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getTasks": <Config extends OperationConfig>(options: { readonly params?: typeof GetTasksParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTasks200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns information about an active long-running task (e.g. space export),
* such as how long it has been running and the percentage of the task that
* has completed.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getTask": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTask200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all target entities that have a particular relationship to the
* source entity. Note, relationships are one way.
*
* For example, the following method finds all content that the current user
* has an 'ignore' relationship with:
* `GET /wiki/rest/api/relation/ignore/from/user/current/to/content`
* Note, 'ignore' is an example custom relationship type.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view both the target entity and source entity.
*/
readonly "findTargetFromSource": <Config extends OperationConfig>(relationName: string, sourceType: string, sourceKey: string, targetType: string, options: { readonly params?: typeof FindTargetFromSourceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof FindTargetFromSource200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Find whether a particular type of relationship exists from a source
* entity to a target entity. Note, relationships are one way.
*
* For example, you can use this method to find whether the current user has
* selected a particular page as a favorite (i.e. 'save for later'):
* `GET /wiki/rest/api/relation/favourite/from/user/current/to/content/123`
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view both the target entity and source entity.
*/
readonly "getRelationship": <Config extends OperationConfig>(relationName: string, sourceType: string, sourceKey: string, targetType: string, targetKey: string, options: { readonly params?: typeof GetRelationshipParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetRelationship200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a relationship between two entities (user, space, content). The
* 'favourite' relationship is supported by default, but you can use this method
* to create any type of relationship between two entities.
*
* For example, the following method creates a 'sibling' relationship between
* two pieces of content:
* `PUT /wiki/rest/api/relation/sibling/from/content/123/to/content/456`
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "createRelationship": <Config extends OperationConfig>(relationName: string, sourceType: string, sourceKey: string, targetType: string, targetKey: string, options: { readonly params?: typeof CreateRelationshipParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof CreateRelationship200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a relationship between two entities (user, space, content).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
* For favourite relationships, the current user can only delete their own
* favourite relationships. A space administrator can delete favourite
* relationships for any user.
*/
readonly "deleteRelationship": <Config extends OperationConfig>(relationName: string, sourceType: string, sourceKey: string, targetType: string, targetKey: string, options: { readonly params?: typeof DeleteRelationshipParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all target entities that have a particular relationship to the
* source entity. Note, relationships are one way.
*
* For example, the following method finds all users that have a 'collaborator'
* relationship to a piece of content with an ID of '1234':
* `GET /wiki/rest/api/relation/collaborator/to/content/1234/from/user`
* Note, 'collaborator' is an example custom relationship type.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view both the target entity and source entity.
*/
readonly "findSourcesForTarget": <Config extends OperationConfig>(relationName: string, targetType: string, targetKey: string, sourceType: string, options: { readonly params?: typeof FindSourcesForTargetParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof FindSourcesForTarget200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Searches for content using the
* [Confluence Query Language (CQL)](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/).
*
* **Note that CQL input queries submitted through the `/wiki/rest/api/search` endpoint no longer support user-specific fields like `user`, `user.fullname`, `user.accountid`, and `user.userkey`.**
* See this [deprecation notice](https://developer.atlassian.com/cloud/confluence/deprecation-notice-search-api/) for more details.
*
* Example initial call:
* ```
* /wiki/rest/api/search?cql=type=page&limit=25
* ```
*
* Example response:
* ```
* {
*   "results": [
*     { ... },
*     { ... },
*     ...
*     { ... }
*   ],
*   "limit": 25,
*   "size": 25,
*   ...
*   "_links": {
*     "base": "<url>",
*     "context": "<url>",
*     "next": "/rest/api/search?cql=type=page&limit=25&cursor=raNDoMsTRiNg",
*     "self": "<url>"
*   }
* }
* ```
*
* When additional results are available, returns `next` and `prev` URLs to retrieve them in subsequent calls. The URLs each contain a cursor that points to the appropriate set of results. Use `limit` to specify the number of results returned in each call.
*
* Example subsequent call (taken from example response):
* ```
* /wiki/rest/api/search?cql=type=page&limit=25&cursor=raNDoMsTRiNg
* ```
* The response to this will have a `prev` URL similar to the `next` in the example response.
*
* If the expand query parameter is used with the `body.export_view` and/or `body.styled_view` properties, then the query limit parameter will be restricted to a maximum value of 25.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to view the entities. Note, only entities that the user has
* permission to view will be returned.
*/
readonly "searchByCQL": <Config extends OperationConfig>(options: { readonly params: typeof SearchByCQLParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SearchByCQL200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Searches for users using user-specific queries from the
* [Confluence Query Language (CQL)](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/).
*
* Note that CQL input queries submitted through the `/wiki/rest/api/search/user` endpoint only support user-specific fields like `user`, `user.fullname`, `user.accountid`, and `user.userkey`.
*
* Note that some user fields may be set to null depending on the user's privacy settings.
* These are: email, profilePicture, displayName, and timeZone.
*/
readonly "searchUser": <Config extends OperationConfig>(options: { readonly params: typeof SearchUserParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SearchUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the look and feel settings for the site or a single space. This
* includes attributes such as the color scheme, padding, and border radius.
*
* The look and feel settings for a space can be inherited from the global
* look and feel settings or provided by a theme.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* None
*/
readonly "getLookAndFeelSettings": <Config extends OperationConfig>(options: { readonly params?: typeof GetLookAndFeelSettingsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetLookAndFeelSettings200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Sets the look and feel settings to the default (global) settings, the
* custom settings, or the current theme's settings for a space.
* The custom and theme settings can only be selected if there is already
* a theme set for a space. Note, the default space settings are inherited
* from the current global settings.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "updateLookAndFeel": <Config extends OperationConfig>(options: { readonly payload: typeof UpdateLookAndFeelRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateLookAndFeel200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the look and feel settings for the site or for a single space.
* If custom settings exist, they are updated. If no custom settings exist,
* then a set of custom settings is created.
*
* Note, if a theme is selected for a space, the space look and feel settings
* are provided by the theme and cannot be overridden.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "updateLookAndFeelSettings": <Config extends OperationConfig>(options: { readonly params?: typeof UpdateLookAndFeelSettingsParams.Encoded | undefined; readonly payload: typeof UpdateLookAndFeelSettingsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateLookAndFeelSettings200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Resets the custom look and feel settings for the site or a single space.
* This changes the values of the custom settings to be the same as the
* default settings. It does not change which settings (default or custom)
* are selected. Note, the default space settings are inherited from the
* current global settings.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "resetLookAndFeelSettings": <Config extends OperationConfig>(options: { readonly params?: typeof ResetLookAndFeelSettingsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the system information for the Confluence Cloud tenant. This
* information is used by Atlassian.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getSystemInfo": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSystemInfo200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all themes, not including the default theme.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**: None
*/
readonly "getThemes": <Config extends OperationConfig>(options: { readonly params?: typeof GetThemesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetThemes200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the globally assigned theme.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**: None
*/
readonly "getGlobalTheme": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetGlobalTheme200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a theme. This includes information about the theme name,
* description, and icon.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**: None
*/
readonly "getTheme": <Config extends OperationConfig>(themeKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTheme200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new space. Note, currently you cannot set space labels when
* creating a space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Create Space(s)' global permission.
*/
readonly "createSpace": <Config extends OperationConfig>(options: { readonly payload: typeof CreateSpaceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new space that is only visible to the creator. This method is
* the same as the [Create space](#api-space-post) method with permissions
* set to the current user only. Note, currently you cannot set space
* labels when creating a space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Create Space(s)' global permission.
*/
readonly "createPrivateSpace": <Config extends OperationConfig>(options: { readonly payload: typeof CreatePrivateSpaceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreatePrivateSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the name, description, or homepage of a space.
*
* -   For security reasons, permissions cannot be updated via the API and
* must be changed via the user interface instead.
* -   Currently you cannot set space labels when updating a space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "updateSpace": <Config extends OperationConfig>(spaceKey: string, options: { readonly payload: typeof UpdateSpaceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Permanently deletes a space without sending it to the trash. Note, the space will be deleted in a long running task.
* Therefore, the space may not be deleted yet when this method has
* returned. Clients should poll the status link that is returned in the
* response until the task completes.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "deleteSpace": <Config extends OperationConfig>(spaceKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteSpace202.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds new permission to space.
*
* If the permission to be added is a group permission, the group can be identified
* by its group name or group id.
*
* Note: Apps cannot access this REST resource - including when utilizing user impersonation.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "addPermissionToSpace": <Config extends OperationConfig>(spaceKey: string, options: { readonly payload: typeof AddPermissionToSpaceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddPermissionToSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds new custom content permission to space.
*
* If the permission to be added is a group permission, the group can be identified
* by its group name or group id.
*
* Note: Only apps can access this REST resource and only make changes to the respective app permissions.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "addCustomContentPermissions": <Config extends OperationConfig>(spaceKey: string, options: { readonly payload: typeof AddCustomContentPermissionsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes a space permission. Note that removing Read Space permission for a user or group will remove all
* the space permissions for that user or group.
*
* Note: Apps cannot access this REST resource - including when utilizing user impersonation.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "removePermission": <Config extends OperationConfig>(spaceKey: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the settings of a space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space.
*/
readonly "getSpaceSettings": <Config extends OperationConfig>(spaceKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceSettings200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates the settings for a space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "updateSpaceSettings": <Config extends OperationConfig>(spaceKey: string, options: { readonly payload: typeof UpdateSpaceSettingsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateSpaceSettings200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get content states that are suggested in the space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space.
*/
readonly "getSpaceContentStates": <Config extends OperationConfig>(spaceKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceContentStates200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get object describing whether content states are allowed at all, if custom content states or space content states
* are restricted, and a list of space content states allowed for the space if they are not restricted.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "getContentStateSettings": <Config extends OperationConfig>(spaceKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetContentStateSettings200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all content that has the provided content state in a space.
*
* If the expand query parameter is used with the `body.export_view` and/or `body.styled_view` properties, then the query limit parameter will be restricted to a maximum value of 25.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space.
*/
readonly "getContentsWithState": <Config extends OperationConfig>(spaceKey: string, options: { readonly params: typeof GetContentsWithStateParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetContentsWithState200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the theme selected for a space, if one is set. If no space
* theme is set, this means that the space is inheriting the global look
* and feel settings.
*
* **[Permissions required](https://confluence.atlassian.com/x/_AozKw)**: ‘View’ permission for the space.
*/
readonly "getSpaceTheme": <Config extends OperationConfig>(spaceKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetSpaceTheme200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Sets the theme for a space. Note, if you want to reset the space theme to
* the default Confluence theme, use the 'Reset space theme' method instead
* of this method.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "setSpaceTheme": <Config extends OperationConfig>(spaceKey: string, options: { readonly payload: typeof SetSpaceThemeRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetSpaceTheme200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Resets the space theme. This means that the space will inherit the
* global look and feel settings
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space.
*/
readonly "resetSpaceTheme": <Config extends OperationConfig>(spaceKey: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a list of watchers of a space
*/
readonly "getWatchersForSpace": <Config extends OperationConfig>(spaceKey: string, options: { readonly params?: typeof GetWatchersForSpaceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWatchersForSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a list of labels associated with a space. Can provide a prefix as well as other filters to
* select different types of labels.
*/
readonly "getLabelsForSpace": <Config extends OperationConfig>(spaceKey: string, options: { readonly params?: typeof GetLabelsForSpaceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetLabelsForSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds labels to a piece of content. Does not modify the existing labels.
*
* Notes:
*
* - Labels can also be added when creating content ([Create content](#api-content-post)).
* - Labels can be updated when updating content ([Update content](#api-content-id-put)).
* This will delete the existing labels and replace them with the labels in
* the request.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to update the content.
*/
readonly "addLabelsToSpace": <Config extends OperationConfig>(spaceKey: string, options: { readonly payload: typeof AddLabelsToSpaceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddLabelsToSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Remove label from a space
*/
readonly "deleteLabelFromSpace": <Config extends OperationConfig>(spaceKey: string, options: { readonly params: typeof DeleteLabelFromSpaceParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates a content template. Note, blueprint templates cannot be updated
* via the REST API.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space to update a space template or 'Confluence Administrator'
* global permission to update a global template.
*/
readonly "updateContentTemplate": <Config extends OperationConfig>(options: { readonly payload: typeof UpdateContentTemplateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateContentTemplate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a new content template. Note, blueprint templates cannot be created via the REST API.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Admin' permission for the space to create a space template or 'Confluence Administrator'
* global permission to create a global template.
*/
readonly "createContentTemplate": <Config extends OperationConfig>(options: { readonly payload: typeof CreateContentTemplateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateContentTemplate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all templates provided by blueprints. Use this method to retrieve
* all global blueprint templates or all blueprint templates in a space.
*
* Note, all global blueprints are inherited by each space. Space blueprints
* can be customised without affecting the global blueprints.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space to view blueprints for the space and permission
* to access the Confluence site ('Can use' global permission) to view global blueprints.
*/
readonly "getBlueprintTemplates": <Config extends OperationConfig>(options: { readonly params?: typeof GetBlueprintTemplatesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetBlueprintTemplates200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all content templates. Use this method to retrieve all global
* content templates or all content templates in a space.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space to view space templates and permission to
* access the Confluence site ('Can use' global permission) to view global templates.
*/
readonly "getContentTemplates": <Config extends OperationConfig>(options: { readonly params?: typeof GetContentTemplatesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetContentTemplates200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a content template. This includes information about template,
* like the name, the space or blueprint that the template is in, the body
* of the template, and more.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'View' permission for the space to view space templates and permission to
* access the Confluence site ('Can use' global permission) to view global templates.
*/
readonly "getContentTemplate": <Config extends OperationConfig>(contentTemplateId: string, options: { readonly params?: typeof GetContentTemplateParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetContentTemplate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a template. This results in different actions depending on the
* type of template:
*
* - If the template is a content template, it is deleted.
* - If the template is a modified space-level blueprint template, it reverts
* to the template inherited from the global-level blueprint template.
* - If the template is a modified global-level blueprint template, it reverts
* to the default global-level blueprint template.
*
*  Note, unmodified blueprint templates cannot be deleted.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
*         'Admin' permission for the space to delete a space template or 'Confluence Administrator'
*         global permission to delete a global template.
*/
readonly "removeTemplate": <Config extends OperationConfig>(contentTemplateId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a user. This includes information about the user, such as the
* display name, account ID, profile picture, and more. The information returned may be
* restricted by the user's profile visibility settings.
*
* **Note:** to add, edit, or delete users in your organization, see the
* [user management REST API](/cloud/admin/user-management/about/).
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getUser": <Config extends OperationConfig>(options: { readonly params: typeof GetUserParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns information about how anonymous users are represented, like the
* profile picture and display name.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getAnonymousUser": <Config extends OperationConfig>(options: { readonly params?: typeof GetAnonymousUserParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAnonymousUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the currently logged-in user. This includes information about
* the user, like the display name, userKey, account ID, profile picture,
* and more.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getCurrentUser": <Config extends OperationConfig>(options: { readonly params?: typeof GetCurrentUserParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCurrentUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the groups that a user is a member of.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getGroupMembershipsForUser": <Config extends OperationConfig>(options: { readonly params: typeof GetGroupMembershipsForUserParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetGroupMembershipsForUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns user details for the ids provided in the request.
* Currently this API returns a maximum of 100 results.
* If more than 100 account ids are passed in, then the first 100 will be returned.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getBulkUserLookup": <Config extends OperationConfig>(options: { readonly params: typeof GetBulkUserLookupParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetBulkUserLookup200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns whether a user is watching a piece of content. Choose the user by
* doing one of the following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission or 'Space Administrator' permission for the relevant space if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "getContentWatchStatus": <Config extends OperationConfig>(contentId: string, options: { readonly params?: typeof GetContentWatchStatusParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetContentWatchStatus200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds a user as a watcher to a piece of content. Choose the user by doing
* one of the following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* Note, you must add the `X-Atlassian-Token: no-check` header when making a
* request, as this operation has XSRF protection.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission or 'Space Administrator' permission for the relevant space if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "addContentWatcher": <Config extends OperationConfig>(contentId: string, options: { readonly params?: typeof AddContentWatcherParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes a user as a watcher from a piece of content. Choose the user by
* doing one of the following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission or 'Space Administrator' permission for the relevant space if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "removeContentWatcher": <Config extends OperationConfig>(contentId: string, options: { readonly params: typeof RemoveContentWatcherParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns whether a user is watching a label. Choose the user by doing one
* of the following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "isWatchingLabel": <Config extends OperationConfig>(labelName: string, options: { readonly params?: typeof IsWatchingLabelParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof IsWatchingLabel200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds a user as a watcher to a label. Choose the user by doing one of the
* following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* Note, you must add the `X-Atlassian-Token: no-check` header when making a
* request, as this operation has XSRF protection.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "addLabelWatcher": <Config extends OperationConfig>(labelName: string, options: { readonly params: typeof AddLabelWatcherParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes a user as a watcher from a label. Choose the user by doing one of
* the following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "removeLabelWatcher": <Config extends OperationConfig>(labelName: string, options: { readonly params?: typeof RemoveLabelWatcherParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns whether a user is watching a space. Choose the user by
* doing one of the following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission or 'Space Administrator' permission for the relevant space if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "isWatchingSpace": <Config extends OperationConfig>(spaceKey: string, options: { readonly params?: typeof IsWatchingSpaceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof IsWatchingSpace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Adds a user as a watcher to a space. Choose the user by doing one of the
* following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* Note, you must add the `X-Atlassian-Token: no-check` header when making a
* request, as this operation has XSRF protection.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission or 'Space Administrator' permission for the relevant space if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "addSpaceWatcher": <Config extends OperationConfig>(spaceKey: string, options: { readonly params: typeof AddSpaceWatcherParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Removes a user as a watcher from a space. Choose the user by doing one of
* the following:
*
* - Specify a user via a query parameter: Use the `accountId` to identify the user.
* - Do not specify a user: The currently logged-in user will be used.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* 'Confluence Administrator' global permission or 'Space Administrator' permission for the relevant space if specifying a user, otherwise
* permission to access the Confluence site ('Can use' global permission).
*/
readonly "removeSpaceWatch": <Config extends OperationConfig>(spaceKey: string, options: { readonly params?: typeof RemoveSpaceWatchParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a user's email address regardless of the user’s profile visibility settings. For Connect apps, this API is only available to apps approved by
* Atlassian, according to these [guidelines](https://community.developer.atlassian.com/t/guidelines-for-requesting-access-to-email-address/27603).
* For Forge apps, this API only supports access via asApp() requests.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getPrivacyUnsafeUserEmail": <Config extends OperationConfig>(options: { readonly params: typeof GetPrivacyUnsafeUserEmailParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetPrivacyUnsafeUserEmail200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns a user's email address regardless of the user’s profile visibility settings. For Connect apps, this API is only available to apps approved by
* Atlassian, according to these [guidelines](https://community.developer.atlassian.com/t/guidelines-for-requesting-access-to-email-address/27603).
* For Forge apps, this API only supports access via asApp() requests.
*
* Any accounts which are not available will not be included in the result.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getPrivacyUnsafeUserEmailBulk": <Config extends OperationConfig>(options: { readonly params: typeof GetPrivacyUnsafeUserEmailBulkParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetPrivacyUnsafeUserEmailBulk200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns all modules registered dynamically by the calling app.
*
* **[Permissions](#permissions) required:** Only Connect apps can make this request.
*/
readonly "getModules": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Registers a list of modules. For the list of modules that support dynamic registration, see [Dynamic modules](https://developer.atlassian.com/cloud/confluence/dynamic-modules/).
*
* **[Permissions](#permissions) required:** Only Connect apps can make this request.
*/
readonly "registerModules": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Remove all or a list of modules registered by the calling app.
*
* **[Permissions](#permissions) required:** Only Connect apps can make this request.
*/
readonly "removeModules": <Config extends OperationConfig>(options: { readonly params: typeof RemoveModulesParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get the total number of views a piece of content has.
*/
readonly "getViews": <Config extends OperationConfig>(contentId: string, options: { readonly params?: typeof GetViewsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetViews200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get the total number of distinct viewers a piece of content has.
*/
readonly "getViewers": <Config extends OperationConfig>(contentId: string, options: { readonly params?: typeof GetViewersParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetViewers200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the properties for a user as list of property keys. For more information
* about user properties, see [Confluence entity properties](https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/).
* `Note`, these properties stored against a user are on a Confluence site level and not space/content level.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getUserProperties": <Config extends OperationConfig>(userId: string, options: { readonly params?: typeof GetUserPropertiesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetUserProperties200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Returns the property corresponding to `key` for a user. For more information
* about user properties, see [Confluence entity properties](https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/).
* `Note`, these properties stored against a user are on a Confluence site level and not space/content level.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "getUserProperty": <Config extends OperationConfig>(userId: string, key: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetUserProperty200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates a property for the given user. Note, you cannot update the key of a user property, only the value.
* For more information about user properties, see
* [Confluence entity properties](https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/).
* `Note`, these properties stored against a user are on a Confluence site level and not space/content level.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "updateUserProperty": <Config extends OperationConfig>(userId: string, key: string, options: { readonly payload: typeof UpdateUserPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creates a property for a user. For more information  about user properties, see [Confluence entity properties]
* (https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/).
* `Note`, these properties stored against a user are on a Confluence site level and not space/content level.
*
* `Note:` the number of properties which could be created per app in a tenant for each user might be
* restricted by fixed system limits.
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "createUserProperty": <Config extends OperationConfig>(userId: string, key: string, options: { readonly payload: typeof CreateUserPropertyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Deletes a property for the given user.
* For more information about user properties, see
* [Confluence entity properties](https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/).
* `Note`, these properties stored against a user are on a Confluence site level and not space/content level.
*
* **[Permissions](https://confluence.atlassian.com/x/_AozKw) required**:
* Permission to access the Confluence site ('Can use' global permission).
*/
readonly "deleteUserProperty": <Config extends OperationConfig>(userId: string, key: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
}

export interface ConfluenceV1ApiError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class ConfluenceV1ApiErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const ConfluenceV1ApiError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): ConfluenceV1ApiError<Tag, E> =>
  new ConfluenceV1ApiErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any
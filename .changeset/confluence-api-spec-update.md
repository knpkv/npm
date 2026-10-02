---
"@knpkv/confluence-api-client": major
"@knpkv/confluence-to-markdown": patch
---

Update the generated Confluence API clients from Atlassian's latest OpenAPI specifications and regenerate them with the current Effect OpenAPI generator.

Breaking: the generator no longer emits component schemas that no operation reaches. The published V1 client drops `AddContentRestriction`, `ConnectModule`, `ContentBodyCreateStorage`, `ContentMetadata`, `ContentProperty`, `GlobalSpaceIdentifier`, `PropertyValue`, `SpaceProperty`, and `Task`; the V2 client drops `DatabaseLinks`, `FolderLinks`, `SmartLinkLinks`, and `WhiteboardLinks`. The V1 client adds `SpacePermissionCreate`. Consumers importing the removed models must define them locally before upgrading.

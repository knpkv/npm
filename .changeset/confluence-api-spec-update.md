---
"@knpkv/confluence-api-client": major
"@knpkv/confluence-to-markdown": patch
---

Update the generated Confluence API clients from Atlassian's latest OpenAPI specifications and regenerate them with the current Effect OpenAPI generator.

Breaking: the generator no longer emits component schemas that no operation reaches. The published V1 client drops `AddContentRestriction`, `ConnectModule`, `ContentBodyCreateStorage`, `ContentMetadata`, `ContentProperty`, `GlobalSpaceIdentifier`, `PropertyValue`, `SpaceProperty`, and `Task`; the V2 client drops `DatabaseLinks`, `FolderLinks`, `SmartLinkLinks`, and `WhiteboardLinks`. The V1 client adds `SpacePermissionCreate`. Consumers importing the removed models must define them locally before upgrading. Several V1 models are now nullable: `ButtonLookAndFeel`, `Container`, `ContainerLookAndFeel`, `Icon`, `NavigationLookAndFeel`, `SearchFieldLookAndFeel`, `Space`, `SpaceDescriptionCreate`, `SpaceSettings`, `SystemInfoEntity`, `User`, `UsersUserKeys`, and `Version`; the V2 `Icon` model is nullable too. Except `SpaceDescriptionCreate`, each of these also accepts unknown keys through an index signature, as do the V1 `LookAndFeel`, `LookAndFeelWithLinks`, `ScreenLookAndFeel`, and `WatchUser` models. `User.operations` and `ContentBlueprintDraft.ancestors` also gain `| null`. Code that reads these models must handle `null`.

# rly agent registry

Generated from @knpkv/rly/component-manifest.ts. Do not edit.

Use `components.json` to choose an existing typed rly export, then import that export from its declared `importPath`.
Use `search.json` for discovery and `schema.json` to validate `components.json` before indexing it.

Maintainers can create a complete component slice with:

`pnpm --filter @knpkv/rly scaffold -- <foundation|primitive|pattern|diff> <PascalName> "<purpose>"`

The scaffolder validates the name, intent, manifest markers, duplicate records, and every target path before writing. A successful run creates source, focused CSS, all-state Storybook story, DOM/a11y test, manifest metadata, generated registry, and public index together.

The registry is documentation and planning input. It contains no component implementation, expression, callback, or JSON-to-React execution format. Applications must continue to compile typed React presenters and govern actions outside rly.

/**
 * Workspace Config parsing and serialization.
 *
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as yaml from "js-yaml"
import { SyncValidationError, SyncWorkspaceError } from "../../JiraCliError.js"
import { WorkspaceConfigSchema } from "./schemas.js"
import type { WorkspaceConfig } from "./types.js"

export const parseWorkspaceConfig = (
  path: string,
  content: string
): Effect.Effect<WorkspaceConfig, SyncWorkspaceError | SyncValidationError> =>
  Effect.gen(function*() {
    const raw = yield* Effect.try({
      try: () => yaml.load(content) ?? {},
      catch: (cause) => new SyncWorkspaceError({ message: "Failed to parse workspace config YAML", path, cause })
    })
    const config: WorkspaceConfig = yield* Schema.decodeUnknownEffect(WorkspaceConfigSchema)(raw).pipe(
      Effect.mapError((cause) =>
        new SyncValidationError({ message: "Invalid Jira Markdown Sync workspace config", path, cause })
      )
    )
    yield* validateCustomFieldDeclarations(path, config)
    return config
  })

export const serializeWorkspaceConfig = (config: WorkspaceConfig): string => yaml.dump(config, { lineWidth: 100 })

export const makeDefaultWorkspaceConfig = (siteUrl: string): WorkspaceConfig => ({
  version: 1,
  siteUrl,
  documentsDir: "issues",
  customFields: []
})

const validateCustomFieldDeclarations = (
  path: string,
  config: WorkspaceConfig
): Effect.Effect<void, SyncValidationError> =>
  Effect.gen(function*() {
    const displayNames = new Map<string, number>()
    const fieldIds = new Set<string>()

    for (const field of config.customFields) {
      displayNames.set(field.displayName, (displayNames.get(field.displayName) ?? 0) + 1)
      if (field.fieldId) {
        if (fieldIds.has(field.fieldId)) {
          return yield* Effect.fail(
            new SyncValidationError({
              message: `Duplicate Requested Custom Field id "${field.fieldId}"`,
              field: field.displayName,
              path
            })
          )
        }
        fieldIds.add(field.fieldId)
      }
    }

    for (const field of config.customFields) {
      if ((displayNames.get(field.displayName) ?? 0) > 1 && !field.fieldId) {
        return yield* Effect.fail(
          new SyncValidationError({
            message: `Duplicate Requested Custom Field "${field.displayName}" must specify fieldId`,
            field: field.displayName,
            path
          })
        )
      }
    }
  })

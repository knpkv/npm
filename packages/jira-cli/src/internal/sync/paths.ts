/**
 * Path helpers for Jira Markdown Sync workspace files.
 *
 * @internal
 */
import type * as Path from "effect/Path"
import type { WorkspaceConfig } from "./types.js"

export const METADATA_DIR = ".jira-md"
export const DEFAULT_DOCUMENTS_DIR = "issues"
export const CONFIG_FILE = "config.yaml"
export const MANIFEST_FILE = "manifest.json"
export const BASELINES_DIR = "baselines"
export const HISTORY_DIR = "history"

export interface SyncWorkspacePaths {
  readonly root: string
  readonly documentsDir: string
  readonly metadataDir: string
  readonly configFile: string
  readonly manifestFile: string
  readonly baselinesDir: string
  readonly historyDir: string
}

export const resolveWorkspacePaths = (
  path: Path.Path,
  root: string,
  config?: Pick<WorkspaceConfig, "documentsDir">
): SyncWorkspacePaths => {
  const documentsDir = path.resolve(root, config?.documentsDir ?? DEFAULT_DOCUMENTS_DIR)
  const metadataDir = path.resolve(root, METADATA_DIR)
  return {
    root: path.resolve(root),
    documentsDir,
    metadataDir,
    configFile: path.join(metadataDir, CONFIG_FILE),
    manifestFile: path.join(metadataDir, MANIFEST_FILE),
    baselinesDir: path.join(metadataDir, BASELINES_DIR),
    historyDir: path.join(metadataDir, HISTORY_DIR)
  }
}

export const baselineFilePath = (path: Path.Path, paths: SyncWorkspacePaths, issueId: string): string =>
  path.join(paths.baselinesDir, `${issueId}.json`)

export const conventionDocumentPath = (path: Path.Path, paths: SyncWorkspacePaths, issueKey: string): string =>
  path.join(paths.documentsDir, `${issueKey}.md`)

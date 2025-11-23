/**
 * Session discovery functionality for Claude Code sessions.
 *
 * Provides utilities to list and discover sessions from ~/.claude/ storage.
 *
 * @module SessionDiscovery
 */

import { FileSystem } from "@effect/platform"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Brand from "./Brand.js"

/**
 * Record representing a Claude Code session.
 *
 * @category Discovery
 */
export interface SessionRecord {
  readonly sessionId: Brand.SessionId
  readonly projectPath: string
  readonly timestamp: number
  readonly display?: string
}

/**
 * History entry from ~/.claude/history.jsonl.
 *
 * @category Discovery
 */
export interface HistoryEntry {
  readonly display: string
  readonly timestamp: number
  readonly project: string
  readonly sessionId?: Brand.SessionId
  readonly pastedContents?: Record<string, unknown>
}

/**
 * Get the home directory path.
 *
 * @internal
 */
const getHomeDirectory = (): Effect.Effect<string, never, never> =>
  Effect.sync(() => {
    // Try HOME first (Unix/Linux/Mac)
    const home = process.env.HOME || process.env.USERPROFILE
    if (home) return home
    // Fallback for Windows
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
      return process.env.HOMEDRIVE + process.env.HOMEPATH
    }
    // Last resort
    return "~"
  })

/**
 * Encode project path for ~/.claude/projects directory naming.
 *
 * Converts absolute paths like `/home/user/project` to encoded form `-home-user-project`
 * by removing leading `/` and replacing all `/` and `.` with `-`, then prefixing with `-`.
 *
 * @param projectPath - The absolute project path to encode
 * @returns The encoded path for use in ~/.claude/projects/
 *
 * @category Utilities
 * @example
 *   import { encodeProjectPath } from "@knpkv/effect-ai-claude-code-cli/SessionDiscovery"
 *
 *   const encoded = encodeProjectPath("/home/user/my.project")
 *   console.log(encoded) // "-home-user-my-project"
 */
export const encodeProjectPath = (projectPath: string): string => {
  const withoutLeadingSlash = projectPath.replace(/^\//, "")
  return `-${withoutLeadingSlash.replace(/[/.]/g, "-")}`
}

/**
 * Get the session directory for a project.
 *
 * Returns the path to ~/.claude/projects/{encoded-path}/ where session files are stored.
 *
 * @param projectPath - The absolute project path
 * @returns Effect yielding the absolute path to the session directory
 *
 * @category Utilities
 * @example
 *   import { getSessionDirectory } from "@knpkv/effect-ai-claude-code-cli/SessionDiscovery"
 *   import { Effect } from "effect"
 *
 *   const program = Effect.gen(function* () {
 *     const dir = yield* getSessionDirectory("/home/user/project")
 *     console.log(dir) // "/home/user/.claude/projects/-home-user-project"
 *   })
 */
export const getSessionDirectory = (
  projectPath: string
): Effect.Effect<string, never, never> =>
  Effect.gen(function*() {
    const home = yield* getHomeDirectory()
    return `${home}/.claude/projects/${encodeProjectPath(projectPath)}`
  })

/**
 * List all sessions for a given project.
 *
 * Reads session files from ~/.claude/projects/{encoded-path}/*.jsonl and returns
 * session metadata. Returns an empty array if the directory doesn't exist or no
 * sessions are found.
 *
 * @param projectPath - The absolute project path
 * @returns Effect yielding array of session records
 *
 * @category Discovery
 * @example
 *   import { listProjectSessions } from "@knpkv/effect-ai-claude-code-cli/SessionDiscovery"
 *   import { NodeFileSystem } from "@effect/platform-node"
 *   import { Effect } from "effect"
 *
 *   const program = Effect.gen(function* () {
 *     const sessions = yield* listProjectSessions(process.cwd())
 *
 *     console.log(`Found ${sessions.length} sessions`)
 *
 *     for (const session of sessions) {
 *       console.log(`- ${session.sessionId}`)
 *       console.log(`  Last modified: ${new Date(session.timestamp)}`)
 *     }
 *   }).pipe(Effect.provide(NodeFileSystem.layer))
 */
export const listProjectSessions = (
  projectPath: string
): Effect.Effect<ReadonlyArray<SessionRecord>, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const sessionDir = yield* getSessionDirectory(projectPath)

    // Check if directory exists
    const exists = yield* fs.exists(sessionDir).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )

    if (!exists) {
      return []
    }

    // Read directory entries
    const entries = yield* fs.readDirectory(sessionDir).pipe(
      Effect.catchAll(() => Effect.succeed([]))
    )

    // Filter for .jsonl files and extract session IDs
    const sessionFiles = entries.filter((entry) => entry.endsWith(".jsonl"))

    const sessions = yield* Effect.forEach(sessionFiles, (filename) =>
      Effect.gen(function*() {
        const sessionIdStr = filename.replace(".jsonl", "")

        // Validate as SessionId
        const sessionIdResult = yield* Schema.decodeUnknown(Brand.SessionIdSchema)(
          sessionIdStr
        ).pipe(Effect.either)

        if (sessionIdResult._tag === "Left") {
          // Invalid session ID, skip this file
          return null
        }

        const sessionId = sessionIdResult.right

        // Get file stats for timestamp
        const filePath = `${sessionDir}/${filename}`
        const statsOption = yield* fs.stat(filePath).pipe(Effect.option)

        const timestamp = Option.match(statsOption, {
          onNone: () => Date.now(),
          onSome: (stats) =>
            Option.match(stats.mtime, {
              onNone: () => Date.now(),
              onSome: (mtime) => mtime.getTime()
            })
        })

        return {
          sessionId,
          projectPath,
          timestamp
        } satisfies SessionRecord
      }))

    // Filter out nulls and return
    return Array.filter(sessions, (s): s is SessionRecord => s !== null)
  })

/**
 * Parse global history index from ~/.claude/history.jsonl.
 *
 * Reads and parses the JSONL history file containing all session history entries.
 * Returns an empty array if the file doesn't exist or parsing fails.
 *
 * @returns Effect yielding array of history entries
 *
 * @category Discovery
 * @example
 *   import { parseHistoryIndex } from "@knpkv/effect-ai-claude-code-cli/SessionDiscovery"
 *   import { NodeFileSystem } from "@effect/platform-node"
 *   import { Effect } from "effect"
 *
 *   const program = Effect.gen(function* () {
 *     const history = yield* parseHistoryIndex()
 *
 *     console.log(`Total history entries: ${history.length}`)
 *
 *     const withSessions = history.filter(entry => entry.sessionId)
 *     console.log(`Entries with session IDs: ${withSessions.length}`)
 *   }).pipe(Effect.provide(NodeFileSystem.layer))
 */
export const parseHistoryIndex = (): Effect.Effect<
  ReadonlyArray<HistoryEntry>,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* getHomeDirectory()
    const historyPath = `${home}/.claude/history.jsonl`

    // Check if file exists
    const exists = yield* fs.exists(historyPath).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )

    if (!exists) {
      return []
    }

    // Read file content
    const content = yield* fs.readFileString(historyPath).pipe(
      Effect.catchAll(() => Effect.succeed(""))
    )

    // Parse JSONL (one JSON per line)
    const lines = content.split("\n").filter((line) => line.trim() !== "")

    const entries = yield* Effect.forEach(lines, (line) =>
      Effect.sync(() => {
        const parsed = JSON.parse(line) as Record<string, unknown>

        const entry: HistoryEntry = {
          display: typeof parsed.display === "string" ? parsed.display : "",
          timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
          project: typeof parsed.project === "string" ? parsed.project : "",
          ...(typeof parsed.sessionId === "string" && {
            sessionId: parsed.sessionId as Brand.SessionId
          }),
          ...(typeof parsed.pastedContents === "object" && parsed.pastedContents !== null && {
            pastedContents: parsed.pastedContents as Record<string, unknown>
          })
        }

        return entry
      }).pipe(Effect.catchAll(() => Effect.succeed(null))))

    return Array.filter(entries, (e): e is HistoryEntry => e !== null)
  })

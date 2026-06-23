/**
 * Integration tests for confluence-to-markdown CLI.
 *
 * Tests full cycle: clone -> create page -> push -> pull -> modify -> push -> re-clone -> delete -> verify
 *
 * Requires:
 * - CONFLUENCE_BASE_URL: Confluence base URL
 * - CONFLUENCE_ROOT_PAGE_ID: Test page ID
 * - OAuth tokens in ~/.confluence/ or CONFLUENCE_API_KEY + CONFLUENCE_EMAIL env vars
 */
import { NodeServices } from "@effect/platform-node"
import { Config, Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let CLI_PATH = ""
let BASE_URL = ""
let ROOT_PAGE_ID = ""

// Test state
interface TestState {
  testDir: string
  pageFile: string | null
  pageSlug: string | null
  pageId: string | null
}

const state: TestState = {
  testDir: "",
  pageFile: null,
  pageSlug: null,
  pageId: null
}

// === Helper Functions ===

const runPlatform = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const runCli = (args: ReadonlyArray<string>, options?: { timeout?: number }) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make("node", [CLI_PATH, ...args], {
      cwd: state.testDir,
      stderr: "inherit"
    })
    return yield* spawner.string(command)
  }).pipe(Effect.timeout(`${options?.timeout ?? 60000} millis`))

const findFile = (dir: string, predicate: (name: string) => boolean) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const exists = yield* fs.exists(dir)
    if (!exists) return null
    const entries = yield* fs.readDirectory(dir, { recursive: true })
    for (const entry of entries) {
      const name = path.basename(entry)
      if (predicate(name)) {
        return path.isAbsolute(entry) ? entry : path.join(dir, entry)
      }
    }
    return null
  })

const pathExists = (filePath: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(filePath))
  )

const readText = (filePath: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(filePath))
  )

const writeText = (filePath: string, content: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(filePath, content))
  )

const removePath = (filePath: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(filePath, options))
  )

const joinPath = (...parts: ReadonlyArray<string>) =>
  Path.Path.pipe(
    Effect.map((path) => path.join(...parts))
  )

const dirname = (filePath: string) =>
  Path.Path.pipe(
    Effect.map((path) => path.dirname(filePath))
  )

const initializeTestEnvironment = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  CLI_PATH = yield* path.fromFileUrl(new URL("../dist/bin.js", import.meta.url))
  BASE_URL = yield* Config.string("CONFLUENCE_BASE_URL")
  ROOT_PAGE_ID = yield* Config.string("CONFLUENCE_ROOT_PAGE_ID")
  state.testDir = yield* fs.makeTempDirectory({ prefix: "confluence-test-" })
})

const cleanupTestEnvironment = Effect.gen(function*() {
  if (state.testDir === "") {
    return
  }
  const exists = yield* pathExists(state.testDir)
  if (exists) {
    yield* removePath(state.testDir, { recursive: true, force: true })
  }
})

const findTemplate = Effect.gen(function*() {
  const docsDir = yield* joinPath(state.testDir, ".confluence/docs")
  return findFile(docsDir, (name) => name.toLowerCase().includes("template") && name.endsWith(".md"))
}).pipe(Effect.flatten)

const findPageBySlug = (slug: string) =>
  Effect.gen(function*() {
    const docsDir = yield* joinPath(state.testDir, ".confluence/docs")
    return findFile(docsDir, (name) => name === `${slug}.md`)
  }).pipe(Effect.flatten)

// === Step Functions ===

/**
 * Clone pages from Confluence with full history.
 */
const clonePages = Effect.gen(function*() {
  const output = yield* runCli(["clone", "--root-page-id", ROOT_PAGE_ID, "--base-url", BASE_URL], { timeout: 120000 })

  expect(output).toContain("Cloning pages from Confluence")
  expect(output).toMatch(/Cloned \d+ pages with \d+ commits/)
  expect(yield* pathExists(yield* joinPath(state.testDir, ".confluence"))).toBe(true)
  expect(yield* pathExists(yield* joinPath(state.testDir, ".confluence/config.json"))).toBe(true)
  expect(yield* pathExists(yield* joinPath(state.testDir, ".confluence/.git"))).toBe(true)

  return output
})

/**
 * Remove .confluence directory for fresh clone.
 */
const removeConfluenceDir = Effect.gen(function*() {
  yield* removePath(yield* joinPath(state.testDir, ".confluence"), { recursive: true, force: true })
})

/**
 * Create a new page by copying template content.
 */
const createPageFromTemplate = Effect.gen(function*() {
  const templatePath = yield* findTemplate
  expect(templatePath).not.toBeNull()

  const templateContent = yield* readText(templatePath!)
  const contentMatch = templateContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/)
  const bodyContent = contentMatch ? contentMatch[1]!.trim() : templateContent

  const templateDir = yield* dirname(templatePath!)
  const timestamp = Date.now()
  const slug = `integration-test-${timestamp}`
  const file = yield* joinPath(templateDir, `${slug}.md`)

  const newPageContent = `---
title: "Integration Test ${timestamp}"
---

${bodyContent}

---
Created by integration test at ${new Date().toISOString()}
`
  yield* writeText(file, newPageContent)
  expect(yield* pathExists(file)).toBe(true)

  state.pageFile = file
  state.pageSlug = slug

  return { file, slug }
})

/**
 * Commit current changes.
 */
const commitChanges = (message: string) =>
  Effect.gen(function*() {
    const output = yield* runCli(["commit", "-m", message])
    expect(output).toContain("Committed:")
    return output
  })

/**
 * Push changes to Confluence.
 */
const pushChanges = Effect.gen(function*() {
  const output = yield* runCli(["push"], { timeout: 90000 })

  const pushedMatch = output.match(/Pushed:\s*(\d+)/)
  const createdMatch = output.match(/Created:\s*(\d+)/)
  const deletedMatch = output.match(/Deleted:\s*(\d+)/)

  return {
    pushed: pushedMatch ? parseInt(pushedMatch[1]!, 10) : 0,
    created: createdMatch ? parseInt(createdMatch[1]!, 10) : 0,
    deleted: deletedMatch ? parseInt(deletedMatch[1]!, 10) : 0
  }
})

/**
 * Pull changes from Confluence.
 */
const pullChanges = runCli(["pull"])

/**
 * Extract pageId from file front-matter.
 */
const extractPageId = (filePath: string) =>
  Effect.gen(function*() {
    const content = yield* readText(filePath)
    const match = content.match(/pageId:\s*["']?(\d+)/)
    return match ? match[1]! : null
  })

/**
 * Modify page content.
 */
const modifyPage = (filePath: string, marker: string) =>
  Effect.gen(function*() {
    const content = yield* readText(filePath)
    yield* writeText(filePath, content + `\n\n${marker}\n`)
  })

/**
 * Delete a local file.
 */
const deleteLocalFile = (filePath: string) =>
  Effect.gen(function*() {
    yield* removePath(filePath)
    expect(yield* pathExists(filePath)).toBe(false)
  })

// === Tests ===

describe("CLI Integration - Page Creation Flow", () => {
  beforeAll(async () => {
    await runPlatform(initializeTestEnvironment)
  })

  afterAll(async () => {
    await runPlatform(cleanupTestEnvironment)
  })

  it("full cycle: clone -> create -> push -> pull -> modify -> push -> re-clone -> delete -> verify", async () => {
    await runPlatform(Effect.gen(function*() {
      // 1. Clone pages from Confluence
      yield* clonePages

      // 2. Create new page from template
      const { file, slug } = yield* createPageFromTemplate

      // 3. Commit and push new page
      yield* commitChanges("Add integration test page")

      const statusBefore = yield* runCli(["status"])
      expect(statusBefore).toContain("Local Only:")

      const pushResult1 = yield* pushChanges
      expect(pushResult1.created).toBe(1)

      // Verify file has pageId after push
      const contentAfterPush = yield* readText(file)
      expect(contentAfterPush).toMatch(/pageId:\s*["']?\d+/)
      expect(contentAfterPush).toMatch(/version:\s*\d+/)
      expect(contentAfterPush).toMatch(/contentHash:/)

      const pageId = yield* extractPageId(file)
      expect(pageId).not.toBeNull()
      state.pageId = pageId

      // 4. Pull should be no-op (already in sync)
      const contentBeforePull = yield* readText(file)
      yield* pullChanges
      const contentAfterPull = yield* readText(file)
      expect(contentAfterPull).toBe(contentBeforePull)

      // 5. Modify page, commit, and push
      const modifyMarker = `Modified at ${Date.now()}`
      yield* modifyPage(file, modifyMarker)
      yield* commitChanges("Modify integration test page")

      const pushResult2 = yield* pushChanges
      expect(pushResult2.pushed).toBe(1)

      const contentAfterModify = yield* readText(file)
      expect(contentAfterModify).toContain(modifyMarker)

      // 6. Remove and re-clone - verify idempotency
      const contentBeforeReclone = yield* readText(file)
      yield* removeConfluenceDir
      yield* clonePages

      const reclonedFile = yield* findPageBySlug(slug)
      expect(reclonedFile).not.toBeNull()
      expect(yield* pathExists(reclonedFile!)).toBe(true)

      const contentAfterReclone = yield* readText(reclonedFile!)
      expect(contentAfterReclone).toBe(contentBeforeReclone)

      // 7. Delete page via git workflow
      yield* deleteLocalFile(reclonedFile!)
      yield* commitChanges("Delete integration test page")

      const pushResult3 = yield* pushChanges
      expect(pushResult3.deleted).toBe(1)

      // 8. Verify deletion - re-clone should not include the page
      yield* removeConfluenceDir
      yield* clonePages

      const deletedFile = yield* findPageBySlug(slug)
      expect(deletedFile).toBeNull()
    }))
  })
})

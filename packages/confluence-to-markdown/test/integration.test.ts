/**
 * Integration tests for confluence-to-markdown CLI.
 *
 * Tests full cycle: clone -> create page -> push -> pull -> modify -> push -> re-clone -> delete -> verify
 *
 * Requires:
 * - CONFLUENCE_BASE_URL: Confluence base URL
 * - CONFLUENCE_ROOT_PAGE_ID: Test page ID (default: 24641561)
 * - OAuth tokens in ~/.confluence/ (from `confluence auth login`)
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const CLI_PATH = path.resolve(__dirname, "../dist/bin.js")
const BASE_URL = process.env.CONFLUENCE_BASE_URL
const ROOT_PAGE_ID = process.env.CONFLUENCE_ROOT_PAGE_ID

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

const runCli = (args: ReadonlyArray<string>, options?: { timeout?: number }): string => {
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd: state.testDir,
    encoding: "utf-8",
    timeout: options?.timeout ?? 60000
  })
}

const findFile = (dir: string, predicate: (name: string) => boolean): string | null => {
  if (!fs.existsSync(dir)) return null
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(fullPath, predicate)
      if (found) return found
    } else if (predicate(entry.name)) {
      return fullPath
    }
  }
  return null
}

const findTemplate = (): string | null => {
  const docsDir = path.join(state.testDir, ".confluence/docs")
  return findFile(docsDir, (name) => name.toLowerCase().includes("template") && name.endsWith(".md"))
}

const findPageBySlug = (slug: string): string | null => {
  const docsDir = path.join(state.testDir, ".confluence/docs")
  return findFile(docsDir, (name) => name === `${slug}.md`)
}

// === Step Functions ===

/**
 * Clone pages from Confluence with full history.
 */
const clonePages = (): string => {
  const output = runCli(["clone", "--root-page-id", ROOT_PAGE_ID, "--base-url", BASE_URL], { timeout: 120000 })

  expect(output).toContain("Cloning pages from Confluence")
  expect(output).toMatch(/Cloned \d+ pages with \d+ commits/)
  expect(fs.existsSync(path.join(state.testDir, ".confluence"))).toBe(true)
  expect(fs.existsSync(path.join(state.testDir, ".confluence/config.json"))).toBe(true)
  expect(fs.existsSync(path.join(state.testDir, ".confluence/.git"))).toBe(true)

  return output
}

/**
 * Remove .confluence directory for fresh clone.
 */
const removeConfluenceDir = (): void => {
  fs.rmSync(path.join(state.testDir, ".confluence"), { recursive: true, force: true })
}

/**
 * Create a new page by copying template content.
 */
const createPageFromTemplate = (): { file: string; slug: string } => {
  const templatePath = findTemplate()
  expect(templatePath).not.toBeNull()

  const templateContent = fs.readFileSync(templatePath!, "utf-8")
  const contentMatch = templateContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/)
  const bodyContent = contentMatch ? contentMatch[1]!.trim() : templateContent

  const templateDir = path.dirname(templatePath!)
  const timestamp = Date.now()
  const slug = `integration-test-${timestamp}`
  const file = path.join(templateDir, `${slug}.md`)

  const newPageContent = `---
title: "Integration Test ${timestamp}"
---

${bodyContent}

---
Created by integration test at ${new Date().toISOString()}
`
  fs.writeFileSync(file, newPageContent)
  expect(fs.existsSync(file)).toBe(true)

  state.pageFile = file
  state.pageSlug = slug

  return { file, slug }
}

/**
 * Commit current changes.
 */
const commitChanges = (message: string): string => {
  const output = runCli(["commit", "-m", message])
  expect(output).toContain("Committed:")
  return output
}

/**
 * Push changes to Confluence.
 */
const pushChanges = (): { pushed: number; created: number; deleted: number } => {
  const output = runCli(["push"], { timeout: 90000 })

  const pushedMatch = output.match(/Pushed:\s*(\d+)/)
  const createdMatch = output.match(/Created:\s*(\d+)/)
  const deletedMatch = output.match(/Deleted:\s*(\d+)/)

  return {
    pushed: pushedMatch ? parseInt(pushedMatch[1]!, 10) : 0,
    created: createdMatch ? parseInt(createdMatch[1]!, 10) : 0,
    deleted: deletedMatch ? parseInt(deletedMatch[1]!, 10) : 0
  }
}

/**
 * Pull changes from Confluence.
 */
const pullChanges = (): string => {
  return runCli(["pull"])
}

/**
 * Extract pageId from file front-matter.
 */
const extractPageId = (filePath: string): string | null => {
  const content = fs.readFileSync(filePath, "utf-8")
  const match = content.match(/pageId:\s*["']?(\d+)/)
  return match ? match[1]! : null
}

/**
 * Modify page content.
 */
const modifyPage = (filePath: string, marker: string): void => {
  const content = fs.readFileSync(filePath, "utf-8")
  fs.writeFileSync(filePath, content + `\n\n${marker}\n`)
}

/**
 * Delete a local file.
 */
const deleteLocalFile = (filePath: string): void => {
  fs.unlinkSync(filePath)
  expect(fs.existsSync(filePath)).toBe(false)
}

// === Tests ===

describe("CLI Integration - Page Creation Flow", () => {
  beforeAll(() => {
    state.testDir = fs.mkdtempSync(path.join(os.tmpdir(), "confluence-test-"))
  })

  afterAll(() => {
    if (state.testDir && fs.existsSync(state.testDir)) {
      fs.rmSync(state.testDir, { recursive: true, force: true })
    }
  })

  it("full cycle: clone -> create -> push -> pull -> modify -> push -> re-clone -> delete -> verify", () => {
    // 1. Clone pages from Confluence
    clonePages()

    // 2. Create new page from template
    const { file, slug } = createPageFromTemplate()

    // 3. Commit and push new page
    commitChanges("Add integration test page")

    const statusBefore = runCli(["status"])
    expect(statusBefore).toContain("Local Only:")

    const pushResult1 = pushChanges()
    expect(pushResult1.created).toBe(1)

    // Verify file has pageId after push
    const contentAfterPush = fs.readFileSync(file, "utf-8")
    expect(contentAfterPush).toMatch(/pageId:\s*["']?\d+/)
    expect(contentAfterPush).toMatch(/version:\s*\d+/)
    expect(contentAfterPush).toMatch(/contentHash:/)

    const pageId = extractPageId(file)
    expect(pageId).not.toBeNull()
    state.pageId = pageId

    // 4. Pull should be no-op (already in sync)
    const contentBeforePull = fs.readFileSync(file, "utf-8")
    pullChanges()
    const contentAfterPull = fs.readFileSync(file, "utf-8")
    expect(contentAfterPull).toBe(contentBeforePull)

    // 5. Modify page, commit, and push
    const modifyMarker = `Modified at ${Date.now()}`
    modifyPage(file, modifyMarker)
    commitChanges("Modify integration test page")

    const pushResult2 = pushChanges()
    expect(pushResult2.pushed).toBe(1)

    const contentAfterModify = fs.readFileSync(file, "utf-8")
    expect(contentAfterModify).toContain(modifyMarker)

    // 6. Remove and re-clone - verify idempotency
    const contentBeforeReclone = fs.readFileSync(file, "utf-8")
    removeConfluenceDir()
    clonePages()

    const reclonedFile = findPageBySlug(slug)
    expect(reclonedFile).not.toBeNull()
    expect(fs.existsSync(reclonedFile!)).toBe(true)

    const contentAfterReclone = fs.readFileSync(reclonedFile!, "utf-8")
    expect(contentAfterReclone).toBe(contentBeforeReclone)

    // 7. Delete page via git workflow
    deleteLocalFile(reclonedFile!)
    commitChanges("Delete integration test page")

    const pushResult3 = pushChanges()
    expect(pushResult3.deleted).toBe(1)

    // 8. Verify deletion - re-clone should not include the page
    removeConfluenceDir()
    clonePages()

    const deletedFile = findPageBySlug(slug)
    expect(deletedFile).toBeNull()
  })
})

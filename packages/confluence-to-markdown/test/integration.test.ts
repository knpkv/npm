/**
 * Integration tests for confluence-to-markdown CLI.
 *
 * Tests full cycle: clone -> create page -> push -> pull -> modify -> push -> re-clone -> delete -> verify
 *
 * Requires:
 * - CONFLUENCE_BASE_URL: Confluence base URL
 * - CONFLUENCE_ROOT_PAGE_ID: Test page ID
 * - CONFLUENCE_API_KEY + CONFLUENCE_EMAIL env vars for raw ADF verification
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Config, Effect, Option } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let CLI_PATH = ""
let BASE_URL = ""
let ROOT_PAGE_ID = ""
let CONFLUENCE_EMAIL = ""
let CONFLUENCE_API_KEY = ""
let HAS_INTEGRATION_CONFIG = false
let HAS_API_AUTH_CONFIG = false

const SHOULD_RUN_INTEGRATION = Effect.runSync(
  Effect.all([
    Config.option(Config.string("CONFLUENCE_BASE_URL")),
    Config.option(Config.string("CONFLUENCE_ROOT_PAGE_ID")),
    Config.option(Config.string("CONFLUENCE_EMAIL")),
    Config.option(Config.string("CONFLUENCE_API_KEY"))
  ]).pipe(
    Effect.map(([baseUrl, rootPageId, email, apiKey]) =>
      Option.isSome(baseUrl) && Option.isSome(rootPageId) && Option.isSome(email) && Option.isSome(apiKey)
    )
  )
)

// Test state
interface TestState {
  testDir: string
  pageFile: string | null
  pageId: string | null
}

const state: TestState = {
  testDir: "",
  pageFile: null,
  pageId: null
}

const timestampForTitle = (date: Date): string => date.toISOString().replace(/[:.]/g, "-")

const timestampLine = (label: string, date: Date): string => `${label} at ${date.toISOString()}`

const RAW_ROUND_TRIP_NODE_TYPES = [
  "blockCard",
  "bodiedExtension",
  "codeBlock",
  "date",
  "decisionItem",
  "decisionList",
  "embedCard",
  "emoji",
  "expand",
  "extension",
  "inlineCard",
  "inlineExtension",
  "layoutColumn",
  "layoutSection",
  "nestedExpand",
  "panel",
  "status",
  "table",
  "tableCell",
  "tableHeader",
  "tableRow",
  "taskItem",
  "taskList"
] as const

const RAW_ROUND_TRIP_MARK_TYPES = [
  "alignment",
  "backgroundColor",
  "breakout",
  "indentation",
  "subsup",
  "textColor",
  "underline"
] as const

interface RawAdfEvidence {
  readonly types: Set<string>
  readonly attrSignatures: Set<string>
  readonly markTypes: Set<string>
  readonly markSignatures: Set<string>
  readonly paragraphMarkSignatures: Set<string>
  readonly inlineCardUrls: Set<string>
}

interface RawAdfSnapshot {
  readonly value: string
  readonly evidence: RawAdfEvidence
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
  const baseUrl = yield* Config.option(Config.string("CONFLUENCE_BASE_URL"))
  const rootPageId = yield* Config.option(Config.string("CONFLUENCE_ROOT_PAGE_ID"))
  const email = yield* Config.option(Config.string("CONFLUENCE_EMAIL"))
  const apiKey = yield* Config.option(Config.string("CONFLUENCE_API_KEY"))
  if (Option.isNone(baseUrl) || Option.isNone(rootPageId)) {
    HAS_INTEGRATION_CONFIG = false
    return
  }
  BASE_URL = baseUrl.value
  ROOT_PAGE_ID = rootPageId.value
  if (Option.isSome(email) && Option.isSome(apiKey)) {
    CONFLUENCE_EMAIL = email.value
    CONFLUENCE_API_KEY = apiKey.value
    HAS_API_AUTH_CONFIG = true
  }
  HAS_INTEGRATION_CONFIG = true
  state.testDir = yield* fs.makeTempDirectory({ prefix: "confluence-test-" })
})

const cleanupTestEnvironment = Effect.gen(function*() {
  if (state.pageId !== null && HAS_API_AUTH_CONFIG) {
    yield* deleteRemotePageIfPresent(state.pageId).pipe(Effect.ignore)
  }
  if (state.testDir === "") {
    return
  }
  const exists = yield* pathExists(state.testDir)
  if (exists) {
    yield* removePath(state.testDir, { recursive: true, force: true })
  }
})

const findSeedMarkdownFile = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const docsDir = yield* joinPath(state.testDir, ".confluence/docs")
  const exists = yield* fs.exists(docsDir)
  if (!exists) return null

  const entries = yield* fs.readDirectory(docsDir, { recursive: true })
  const markdownFiles = entries
    .filter((entry) => path.basename(entry).endsWith(".md"))
    .sort((a, b) => {
      const aName = path.basename(a).toLowerCase()
      const bName = path.basename(b).toLowerCase()
      const aIsTemplate = aName.includes("template")
      const bIsTemplate = bName.includes("template")
      if (aIsTemplate !== bIsTemplate) return aIsTemplate ? -1 : 1
      return b.split(/[\\/]/).length - a.split(/[\\/]/).length
    })

  const entry = markdownFiles[0]
  if (!entry) return null
  return path.isAbsolute(entry) ? entry : path.join(docsDir, entry)
})

const findPageByPageId = (pageId: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const docsDir = yield* joinPath(state.testDir, ".confluence/docs")
    const exists = yield* fs.exists(docsDir)
    if (!exists) return null

    const entries = yield* fs.readDirectory(docsDir, { recursive: true })
    for (const entry of entries) {
      if (!path.basename(entry).endsWith(".md")) continue
      const filePath = path.isAbsolute(entry) ? entry : path.join(docsDir, entry)
      const content = yield* readText(filePath)
      if (content.match(new RegExp(`pageId:\\s*["']?${pageId}["']?`))) {
        return filePath
      }
    }
    return null
  })

// === Step Functions ===

/**
 * Clone pages from Confluence with full history.
 */
const clonePages = Effect.gen(function*() {
  const output = yield* runCli(["workspace", "clone", "--root-page-id", ROOT_PAGE_ID, "--base-url", BASE_URL], {
    timeout: 120000
  })

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
 * Create a new page by copying content from a cloned seed page.
 */
const createPageFromSeed = Effect.gen(function*() {
  const seedPath = yield* findSeedMarkdownFile
  expect(seedPath).not.toBeNull()

  const seedContent = yield* readText(seedPath!)
  const contentMatch = seedContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/)
  const bodyContent = contentMatch ? contentMatch[1]!.trim() : seedContent
  const seedPageId = extractPageIdFromMarkdown(seedContent)

  const templateDir = yield* dirname(seedPath!)
  const createdAt = new Date()
  const timestamp = timestampForTitle(createdAt)
  const slug = `integration-test-${timestamp}`
  const file = yield* joinPath(templateDir, `${slug}.md`)
  const createMarker = timestampLine("Created by integration test", createdAt)

  const newPageContent = `---
title: "Integration Test ${timestamp}"
---

${bodyContent}

---
${createMarker}
`
  yield* writeText(file, newPageContent)
  expect(yield* pathExists(file)).toBe(true)

  state.pageFile = file

  return { file, createMarker, seedPageId, timestamp }
})

/**
 * Commit current changes.
 */
const commitChanges = (message: string) =>
  Effect.gen(function*() {
    const output = yield* runCli(["sync", "commit", "-m", message])
    expect(output).toContain("Committed:")
    return output
  })

/**
 * Push changes to Confluence.
 */
const pushChanges = Effect.gen(function*() {
  const output = yield* runCli(["sync", "push"], { timeout: 90000 })

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
const pullChanges = runCli(["sync", "pull"])

/**
 * Extract pageId from file front-matter.
 */
const extractPageId = (filePath: string) =>
  Effect.gen(function*() {
    const content = yield* readText(filePath)
    return extractPageIdFromMarkdown(content)
  })

const extractPageIdFromMarkdown = (content: string): string | null => {
  const match = content.match(/pageId:\s*["']?(\d+)/)
  return match ? match[1]! : null
}

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

const adfEvidence = (adf: unknown): RawAdfEvidence => {
  const evidence: RawAdfEvidence = {
    types: new Set<string>(),
    attrSignatures: new Set<string>(),
    markTypes: new Set<string>(),
    markSignatures: new Set<string>(),
    paragraphMarkSignatures: new Set<string>(),
    inlineCardUrls: new Set<string>()
  }
  const selectedMarkTypes = new Set<string>(RAW_ROUND_TRIP_MARK_TYPES)
  const selectedNodeTypes = new Set<string>(RAW_ROUND_TRIP_NODE_TYPES)
  const normalizeAttrs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalizeAttrs)
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .map(([key, v]) => [key, normalizeAttrs(v)] as const)
        .filter(([key, v]) => {
          if (key === "localId" || key === "macroMetadata") return false
          if (key === "layout" && v === "default") return false
          if (key === "macroId" && v !== null && typeof v === "object") return false
          if (
            (key === "macroParams" || key === "parameters") &&
            v !== null &&
            typeof v === "object" &&
            !Array.isArray(v) &&
            Object.keys(v).length === 0
          ) {
            return false
          }
          return true
        })
      return Object.fromEntries(entries)
    }
    return value
  }
  const stableJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
    if (value !== null && typeof value === "object") {
      return `{${
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
          .join(",")
      }}`
    }
    return JSON.stringify(value) ?? "null"
  }
  const markSignature = (mark: Record<string, unknown>): string =>
    `${String(mark["type"])}:${stableJson(mark["attrs"] ?? {})}`
  const cardUrl = (attrs: Record<string, unknown>): string | null => {
    const url = attrs["url"]
    if (typeof url === "string") return url
    const data = attrs["data"]
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const dataUrl = (data as Record<string, unknown>)["url"]
      if (typeof dataUrl === "string") return dataUrl
    }
    return null
  }
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return
    const record = node as Record<string, unknown>
    const type = record["type"]
    if (typeof type === "string") evidence.types.add(type)
    const attrs = record["attrs"]
    if (
      typeof type === "string" &&
      selectedNodeTypes.has(type) &&
      attrs !== null &&
      typeof attrs === "object" &&
      !Array.isArray(attrs)
    ) {
      const normalized = normalizeAttrs(attrs)
      const extensionKey = (normalized as Record<string, unknown>)["extensionKey"]
      if (!(type === "extension" && extensionKey === "toc")) {
        evidence.attrSignatures.add(`${type}:${stableJson(normalized)}`)
      }
    }
    if (type === "inlineCard") {
      if (attrs !== null && typeof attrs === "object" && !Array.isArray(attrs)) {
        const url = cardUrl(attrs as Record<string, unknown>)
        if (url !== null) evidence.inlineCardUrls.add(url)
      }
    }
    const marks = record["marks"]
    if (Array.isArray(marks)) {
      for (const mark of marks) {
        if (mark === null || typeof mark !== "object" || Array.isArray(mark)) continue
        const markRecord = mark as Record<string, unknown>
        const markType = markRecord["type"]
        if (typeof markType !== "string") continue
        evidence.markTypes.add(markType)
        if (selectedMarkTypes.has(markType)) {
          const signature = markSignature(markRecord)
          evidence.markSignatures.add(signature)
          if (type === "paragraph") evidence.paragraphMarkSignatures.add(signature)
        }
      }
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) {
        for (const item of child) walk(item)
      } else {
        walk(child)
      }
    }
  }
  walk(adf)
  return evidence
}

const getRemoteAdfSnapshot = (pageId: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${BASE_URL}/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`, {
        headers: {
          Authorization: `Basic ${btoa(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_KEY}`)}`
        }
      })
      if (!response.ok) {
        throw new Error(`Confluence returned ${response.status} for page ${pageId}`)
      }
      const page = await response.json() as { body?: { atlas_doc_format?: { value?: string } } }
      const value = page.body?.atlas_doc_format?.value ?? "{}"
      const adf = JSON.parse(value) as unknown
      return { value, evidence: adfEvidence(adf) }
    },
    catch: (cause) => cause
  })

const deleteRemotePageIfPresent = (pageId: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${BASE_URL}/wiki/api/v2/pages/${pageId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${btoa(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_KEY}`)}`
        }
      })
      if (!response.ok && response.status !== 404) {
        throw new Error(`Confluence returned ${response.status} while cleaning up page ${pageId}`)
      }
    },
    catch: (cause) => cause
  })

const expectNativePanelsIfPresent = (pageId: string, markdown: string) =>
  Effect.gen(function*() {
    if (!HAS_API_AUTH_CONFIG || !markdown.includes("adf:panel")) {
      return
    }
    const snapshot = yield* getRemoteAdfSnapshot(pageId)
    expect(snapshot.evidence.types.has("panel")).toBe(true)
  })

const expectRawRoundTripTypes = (
  before: RawAdfSnapshot,
  after: RawAdfSnapshot
) =>
  Effect.sync(() => {
    for (const type of RAW_ROUND_TRIP_NODE_TYPES) {
      if (before.evidence.types.has(type)) {
        expect(after.evidence.types.has(type), `expected raw ADF after push to preserve ${type}`).toBe(true)
      }
    }
    for (const signature of before.evidence.attrSignatures) {
      expect(after.evidence.attrSignatures.has(signature), `expected raw ADF after push to preserve attrs ${signature}`)
        .toBe(true)
    }
    for (const mark of RAW_ROUND_TRIP_MARK_TYPES) {
      if (before.evidence.markTypes.has(mark)) {
        expect(after.evidence.markTypes.has(mark), `expected raw ADF after push to preserve ${mark} marks`).toBe(true)
      }
    }
    for (const signature of before.evidence.markSignatures) {
      expect(after.evidence.markSignatures.has(signature), `expected raw ADF after push to preserve mark ${signature}`)
        .toBe(true)
    }
    for (const signature of before.evidence.paragraphMarkSignatures) {
      expect(
        after.evidence.paragraphMarkSignatures.has(signature),
        `expected raw ADF after push to preserve paragraph mark ${signature}`
      ).toBe(true)
    }
    for (const url of before.evidence.inlineCardUrls) {
      expect(after.evidence.inlineCardUrls.has(url), `expected raw ADF after push to preserve inlineCard ${url}`).toBe(
        true
      )
    }
  })

const expectSidecarMetadata = (filePath: string, pageId: string, markdown: string) =>
  Effect.gen(function*() {
    const dir = yield* dirname(filePath)
    const sidecarPath = yield* joinPath(dir, `${pageId}.adf.json`)
    expect(markdown).toMatch(new RegExp(`ref=\\./${pageId}\\.adf\\.json#[A-Za-z0-9-]+`))
    expect(markdown).not.toMatch(/<!--\s*adf:[^>]+(?:attrs|node|marks)=/)
    expect(yield* pathExists(sidecarPath)).toBe(true)

    const sidecar = JSON.parse(yield* readText(sidecarPath)) as unknown
    expect(sidecar).toMatchObject({ version: 1 })

    const record = sidecar !== null && typeof sidecar === "object" && !Array.isArray(sidecar)
      ? sidecar as Record<string, unknown>
      : {}
    const entries = record["entries"] !== null && typeof record["entries"] === "object" &&
        !Array.isArray(record["entries"])
      ? record["entries"] as Record<string, unknown>
      : {}
    expect(Object.keys(entries).length).toBeGreaterThan(0)
    expect(
      Object.values(entries).some((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false
        const value = (entry as Record<string, unknown>)["value"]
        return value !== null && typeof value === "object"
      })
    ).toBe(true)
  })

// === Tests ===

describe("CLI Integration - Page Creation Flow", () => {
  beforeAll(async () => {
    await runPlatform(initializeTestEnvironment)
  })

  afterAll(async () => {
    await runPlatform(cleanupTestEnvironment)
  })

  it.skipIf(!SHOULD_RUN_INTEGRATION)(
    "full cycle: clone -> create -> push -> pull -> modify -> push -> re-clone -> delete -> verify",
    async () => {
      if (!HAS_INTEGRATION_CONFIG) {
        throw new Error("Confluence integration config was available at test definition but missing at setup")
      }

      await runPlatform(Effect.gen(function*() {
        // 1. Clone pages from Confluence
        yield* clonePages

        // 2. Create new page from template
        const { createMarker, file, seedPageId, timestamp } = yield* createPageFromSeed
        const seedRawAdf = seedPageId && HAS_API_AUTH_CONFIG ? yield* getRemoteAdfSnapshot(seedPageId) : null

        // 3. Commit and push new page
        yield* commitChanges(`Add integration test page ${timestamp}`)

        const statusBefore = yield* runCli(["sync", "status"])
        expect(statusBefore).toContain("Local Only:")

        const pushResult1 = yield* pushChanges
        expect(pushResult1.created).toBe(1)

        // Verify file has pageId after push
        const contentAfterPush = yield* readText(file)
        expect(contentAfterPush).toMatch(/pageId:\s*["']?\d+/)
        expect(contentAfterPush).toMatch(/version:\s*\d+/)
        expect(contentAfterPush).toMatch(/contentHash:/)
        expect(contentAfterPush).toContain(createMarker)

        const pageId = yield* extractPageId(file)
        expect(pageId).not.toBeNull()
        state.pageId = pageId
        yield* expectSidecarMetadata(file, pageId!, contentAfterPush)
        yield* expectNativePanelsIfPresent(pageId!, contentAfterPush)
        const createdRawAdf = HAS_API_AUTH_CONFIG ? yield* getRemoteAdfSnapshot(pageId!) : null
        if (seedRawAdf !== null && createdRawAdf !== null) {
          yield* expectRawRoundTripTypes(seedRawAdf, createdRawAdf)
        }

        // 4. Pull should be no-op (already in sync)
        const contentBeforePull = yield* readText(file)
        yield* pullChanges
        const contentAfterPull = yield* readText(file)
        expect(contentAfterPull).toBe(contentBeforePull)

        // 5. Modify page, commit, and push
        const modifiedAt = new Date()
        const modifyMarker = timestampLine("Modified by integration test", modifiedAt)
        yield* modifyPage(file, modifyMarker)
        yield* commitChanges(`Modify integration test page ${timestampForTitle(modifiedAt)}`)

        const pushResult2 = yield* pushChanges
        expect(pushResult2.pushed).toBe(1)

        const contentAfterModify = yield* readText(file)
        expect(contentAfterModify).toContain(modifyMarker)
        yield* expectSidecarMetadata(file, pageId!, contentAfterModify)
        yield* expectNativePanelsIfPresent(pageId!, contentAfterModify)
        const modifiedRawAdf = HAS_API_AUTH_CONFIG ? yield* getRemoteAdfSnapshot(pageId!) : null
        if (createdRawAdf !== null && modifiedRawAdf !== null) {
          yield* expectRawRoundTripTypes(createdRawAdf, modifiedRawAdf)
        }

        // 6. Remove and re-clone - verify idempotency
        const contentBeforeReclone = yield* readText(file)
        yield* removeConfluenceDir
        yield* clonePages

        const reclonedFile = yield* findPageByPageId(pageId!)
        expect(reclonedFile).not.toBeNull()
        expect(yield* pathExists(reclonedFile!)).toBe(true)

        const contentAfterReclone = yield* readText(reclonedFile!)
        expect(contentAfterReclone).toBe(contentBeforeReclone)
        expect(contentAfterReclone).toContain(createMarker)
        expect(contentAfterReclone).toContain(modifyMarker)
        yield* expectSidecarMetadata(reclonedFile!, pageId!, contentAfterReclone)

        // 7. Delete page via git workflow
        yield* deleteLocalFile(reclonedFile!)
        yield* commitChanges(`Delete integration test page ${timestampForTitle(new Date())}`)

        const pushResult3 = yield* pushChanges
        expect(pushResult3.deleted).toBe(1)

        // 8. Verify deletion - re-clone should not include the page
        yield* removeConfluenceDir
        yield* clonePages

        const deletedFile = yield* findPageByPageId(pageId!)
        expect(deletedFile).toBeNull()
        state.pageId = null
      }))
    }
  )
})

/**
 * Integration tests for confluence-to-markdown CLI.
 *
 * Tests full cycle: clone -> edit -> commit -> push -> pull
 *
 * Requires:
 * - CONFLUENCE_BASE_URL: Confluence base URL
 * - CONFLUENCE_ROOT_PAGE_ID: Test page ID
 * - OAuth tokens in ~/.confluence/ (from `confluence auth login`)
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const CLI_PATH = path.resolve(__dirname, "../dist/bin.js")
const BASE_URL = process.env.CONFLUENCE_BASE_URL ?? "https://anthropic-se.atlassian.net"
const ROOT_PAGE_ID = process.env.CONFLUENCE_ROOT_PAGE_ID ?? "20611073"

let testDir: string

const runCli = (args: ReadonlyArray<string>): string => {
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd: testDir,
    encoding: "utf-8",
    timeout: 60000
  })
}

describe("CLI Integration", () => {
  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "confluence-test-"))
  })

  afterAll(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  it("clone - pulls pages with history", () => {
    const output = runCli(["clone", "--root-page-id", ROOT_PAGE_ID, "--base-url", BASE_URL])

    expect(output).toContain("Cloning pages from Confluence")
    expect(output).toMatch(/Cloned \d+ pages with \d+ commits/)

    // Verify .confluence directory created
    expect(fs.existsSync(path.join(testDir, ".confluence"))).toBe(true)
    expect(fs.existsSync(path.join(testDir, ".confluence/config.json"))).toBe(true)
    expect(fs.existsSync(path.join(testDir, ".confluence/.git"))).toBe(true)
  })

  it("clone - fails if already cloned", () => {
    expect(() => runCli(["clone", "--root-page-id", ROOT_PAGE_ID, "--base-url", BASE_URL]))
      .toThrow(/Already cloned/)
  })

  it("status - shows sync status", () => {
    const output = runCli(["status"])

    expect(output).toContain("Git: initialized")
    expect(output).toContain("Sync Status:")
    expect(output).toContain("Synced:")
  })

  it("log - shows git history", () => {
    const output = runCli(["log", "--oneline", "-n", "5"])

    // Should have commits from history replay
    expect(output.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(1)
  })

  it("edit -> commit -> push -> re-clone produces identical content", () => {
    // Find a markdown file
    const docsDir = path.join(testDir, ".confluence/docs")
    const mdFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"))
    expect(mdFiles.length).toBeGreaterThan(0)

    const testFile = path.join(docsDir, mdFiles[0]!)
    const testMarker = `Integration test ${Date.now()}`

    // Edit file
    const content = fs.readFileSync(testFile, "utf-8")
    fs.writeFileSync(testFile, content + `\n\n${testMarker}\n`)

    // Commit
    const commitOutput = runCli(["commit", "-m", testMarker])
    expect(commitOutput).toContain("Committed:")

    // Push - this should auto-amend with canonical content
    const pushOutput = runCli(["push"])
    expect(pushOutput).toContain("Pushed: 1")

    // Save content after push (should be canonical from Confluence)
    const contentAfterPush = fs.readFileSync(testFile, "utf-8")

    // Remove .confluence and re-clone
    fs.rmSync(path.join(testDir, ".confluence"), { recursive: true, force: true })
    runCli(["clone", "--root-page-id", ROOT_PAGE_ID, "--base-url", BASE_URL])

    // Content after fresh clone should be IDENTICAL to content after push
    const contentAfterClone = fs.readFileSync(testFile, "utf-8")
    expect(contentAfterClone).toBe(contentAfterPush)
  })

  it("multi-commit push combines into single Confluence version", () => {
    // Find a markdown file
    const docsDir = path.join(testDir, ".confluence/docs")
    const mdFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"))
    const testFile = path.join(docsDir, mdFiles[0]!)

    // Make 3 commits
    const markers = [
      `Multi-commit test A ${Date.now()}`,
      `Multi-commit test B ${Date.now() + 1}`,
      `Multi-commit test C ${Date.now() + 2}`
    ]

    for (const marker of markers) {
      const content = fs.readFileSync(testFile, "utf-8")
      fs.writeFileSync(testFile, content + `\n\n${marker}\n`)
      runCli(["commit", "-m", marker])
    }

    // Push should push 1 file (final state)
    const pushOutput = runCli(["push"])
    expect(pushOutput).toContain("Pushed: 1")

    // Save content after push
    const contentAfterPush = fs.readFileSync(testFile, "utf-8")

    // Re-clone and verify all markers present
    fs.rmSync(path.join(testDir, ".confluence"), { recursive: true, force: true })
    runCli(["clone", "--root-page-id", ROOT_PAGE_ID, "--base-url", BASE_URL])

    // Content should match
    const contentAfterClone = fs.readFileSync(testFile, "utf-8")
    expect(contentAfterClone).toBe(contentAfterPush)

    // All markers should be in content (pushed as single version)
    for (const marker of markers) {
      expect(contentAfterClone).toContain(marker)
    }
  })

  it("diff - shows changes", () => {
    // Make a change
    const docsDir = path.join(testDir, ".confluence/docs")
    const mdFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"))
    const testFile = path.join(docsDir, mdFiles[0]!)

    const content = fs.readFileSync(testFile, "utf-8")
    fs.writeFileSync(testFile, content + "\n\nDiff test line\n")

    const diffOutput = runCli(["diff"])
    expect(diffOutput).toContain("Diff test line")

    // Revert change
    fs.writeFileSync(testFile, content)
  })
})

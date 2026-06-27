import { constants } from "node:fs"
import { access, cp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

const mode = process.argv[2] ?? "check"
const validModes = new Set(["check", "write"])

if (!validModes.has(mode)) {
  console.error("Usage: node scripts/sync-skills.mjs [check|write]")
  process.exit(1)
}

const roots = [
  ["codecommit", "packages/codecommit/skills/codecommit"],
  ["confluence", "packages/confluence-to-markdown/skills/confluence"],
  ["jcf", "packages/jira-clockify/skills/jcf"],
  ["jira", "packages/jira-cli/skills/jira"]
]

const exists = async (path) => {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const collectFiles = async (dir, prefix = "") => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute, relative)))
    } else if (entry.isFile()) {
      files.push(relative)
    }
  }
  return files.sort()
}

const sameTree = async (source, destination) => {
  if (!(await exists(destination))) return false
  const [sourceFiles, destinationFiles] = await Promise.all([collectFiles(source), collectFiles(destination)])
  if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) return false

  for (const relative of sourceFiles) {
    const [sourceContent, destinationContent] = await Promise.all([
      readFile(join(source, relative)),
      readFile(join(destination, relative))
    ])
    if (!sourceContent.equals(destinationContent)) return false
  }

  return true
}

const copySkill = async (source, destination) => {
  await rm(destination, { force: true, recursive: true })
  await cp(source, destination, { recursive: true })
}

const outOfSync = []

for (const [skill, destination] of roots) {
  const source = `packages/agent-skills/skills/${skill}`
  if (mode === "write") {
    await copySkill(source, destination)
    console.log(`synced ${skill}: ${source} -> ${destination}`)
  } else if (!(await sameTree(source, destination))) {
    outOfSync.push(`${skill}: ${destination}`)
  }
}

if (outOfSync.length > 0) {
  console.error("Product-local skills are out of sync with packages/agent-skills/skills:")
  for (const line of outOfSync) console.error(`  ${line}`)
  console.error("Run: pnpm skills:sync")
  process.exit(1)
}

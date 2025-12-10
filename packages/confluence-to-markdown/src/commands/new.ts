/**
 * New page command for Confluence CLI.
 */
import { Command, Prompt } from "@effect/cli"
import * as Path from "@effect/platform/Path"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { ConfluenceConfig } from "../ConfluenceConfig.js"
import { LocalFileSystem } from "../LocalFileSystem.js"
import { flattenPageTree } from "./pageTree.js"

/** Slugify a title for use as filename */
const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

export const newCommand = Command.make("new", {}, () =>
  Effect.gen(function*() {
    const localFs = yield* LocalFileSystem
    const config = yield* ConfluenceConfig
    const pathService = yield* Path.Path

    const docsPath = pathService.join(process.cwd(), config.docsPath)

    // Build page tree
    yield* Console.log("Scanning page structure...")
    const tree = yield* localFs.buildPageTree(docsPath, config.rootPageId, "Root")

    // Check if we have any pages
    const hasPages = tree.children.length > 0 || tree.pageId !== null

    if (!hasPages) {
      yield* Console.log("No pages found. Run 'confluence clone' or 'confluence pull' first.")
      return
    }

    // Flatten to choices
    const choices = flattenPageTree(tree)

    // Show parent selector
    const parent = yield* Prompt.select({
      message: "Select parent page for the new page:",
      choices
    })

    // Prompt for title
    const title = yield* Prompt.text({
      message: "Enter page title:"
    })

    if (!title.trim()) {
      yield* Console.log("Title cannot be empty")
      return
    }

    // Generate filename
    const filename = `${slugify(title.trim())}.md`

    // Determine file path
    // If parent is root (path === ""), create in docsPath
    // If parent has children, create in parent's directory
    let filePath: string
    if (parent.path === "") {
      // Root level
      filePath = pathService.join(docsPath, filename)
    } else {
      // Under a page - check if parent directory exists
      const parentBasename = pathService.basename(parent.path, ".md")
      const parentDir = pathService.dirname(parent.path)
      const targetDir = parentDir === "." ? parentBasename : pathService.join(parentDir, parentBasename)
      filePath = pathService.join(docsPath, targetDir, filename)
    }

    // Check if file already exists
    const exists = yield* localFs.exists(filePath)
    if (exists) {
      yield* Console.log(`File already exists: ${filePath}`)
      return
    }

    // Write new page file with title-only front-matter
    yield* localFs.writeNewPageFile(
      filePath,
      { title: title.trim() },
      "\n<!-- Write your page content here -->\n"
    )

    const relativePath = pathService.relative(process.cwd(), filePath)
    yield* Console.log(`Created new page: ${relativePath}`)
    yield* Console.log("")
    yield* Console.log("Next steps:")
    yield* Console.log("  1. Edit the file to add content")
    yield* Console.log("  2. Run 'confluence commit' to stage changes")
    yield* Console.log("  3. Run 'confluence push' to create on Confluence")
  })).pipe(Command.withDescription("Create a new page to be pushed to Confluence"))

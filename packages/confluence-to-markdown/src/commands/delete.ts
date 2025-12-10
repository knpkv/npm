/**
 * Delete command for Confluence CLI.
 *
 * Interactive mode: select page from tree, delete local file only.
 * Push to actually delete from Confluence.
 */
import { Command, Prompt } from "@effect/cli"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { ConfluenceConfig } from "../ConfluenceConfig.js"
import { LocalFileSystem } from "../LocalFileSystem.js"
import { flattenPageTree } from "./pageTree.js"

export const deleteCommand = Command.make("delete", {}, () =>
  Effect.gen(function*() {
    const localFs = yield* LocalFileSystem
    const config = yield* ConfluenceConfig
    const pathService = yield* Path.Path
    const fs = yield* FileSystem.FileSystem

    const docsPath = pathService.join(process.cwd(), config.docsPath)

    // Interactive mode - show page tree, delete local file
    yield* Console.log("Scanning page structure...")
    const tree = yield* localFs.buildPageTree(docsPath, config.rootPageId, "Root")

    // Flatten to choices (exclude pages without pageId - they're not on Confluence)
    const allChoices = flattenPageTree(tree)
    const choices = allChoices.filter((c) => c.value.pageId !== null)

    if (choices.length === 0) {
      yield* Console.log("No pages found to delete. Run 'confluence clone' or 'confluence pull' first.")
      return
    }

    const selected = yield* Prompt.select({
      message: "Select page to delete:",
      choices
    })

    if (!selected.pageId || !selected.path) {
      yield* Console.log("Selected page has no pageId - cannot delete.")
      return
    }

    // Delete local file
    const filePath = pathService.join(docsPath, selected.path)
    yield* fs.remove(filePath)

    yield* Console.log(`Deleted: ${selected.path}`)
    yield* Console.log("")
    yield* Console.log("Next steps:")
    yield* Console.log("  1. Run 'confluence commit' to stage the deletion")
    yield* Console.log("  2. Run 'confluence push' to delete from Confluence")
  })).pipe(Command.withDescription("Delete a page locally (push to remove from Confluence)"))

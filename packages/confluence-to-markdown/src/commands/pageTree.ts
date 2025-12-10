/**
 * Shared page tree utilities for CLI commands.
 */
import type { PageTreeNode } from "../LocalFileSystem.js"

export interface PageChoice {
  readonly title: string
  readonly value: {
    readonly path: string
    readonly pageId: string | null
    readonly nodeTitle: string
  }
  readonly description?: string
}

/**
 * Flatten page tree to choices with indentation for interactive prompts.
 */
export const flattenPageTree = (
  node: PageTreeNode,
  depth: number = 0
): ReadonlyArray<PageChoice> => {
  const indent = "  ".repeat(depth)
  const prefix = depth === 0 ? "" : "├─ "
  const choices: Array<PageChoice> = []

  choices.push({
    title: `${indent}${prefix}${node.title}`,
    value: { path: node.path, pageId: node.pageId, nodeTitle: node.title },
    description: node.pageId ? `Page ID: ${node.pageId}` : "Root"
  })

  for (const child of node.children) {
    for (const choice of flattenPageTree(child, depth + 1)) {
      choices.push(choice)
    }
  }

  return choices
}

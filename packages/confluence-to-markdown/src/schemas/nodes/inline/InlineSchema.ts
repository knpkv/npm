/**
 * Transform schemas for inline nodes (Hast <-> AST <-> Mdast).
 *
 * Provides bidirectional transforms between HAST elements, AST inline nodes,
 * and MDAST phrasing content for text-level formatting.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import {
  ColoredText,
  DateTime,
  Emoticon,
  Emphasis,
  Highlight,
  InlineCode,
  type InlineNode,
  LineBreak,
  Link,
  Strikethrough,
  Strong,
  Subscript,
  Superscript,
  Text,
  Underline,
  UnsupportedInline,
  UserMention
} from "../../../ast/InlineNode.js"
import type { HastElement, HastNode, HastText } from "../../hast/index.js"
import { getTextContent, isHastElement, isHastText, makeHastElement, makeHastText } from "../../hast/index.js"
import type { MdastPhrasingContent } from "../../mdast/index.js"
import { makeMdastText } from "../../mdast/index.js"

/**
 * Convert HAST text node to AST Text.
 */
export const textFromHastText = (node: HastText): Text => new Text({ value: node.value })

/**
 * Convert HAST element to AST inline node.
 */
export const inlineNodeFromHastElement = (
  element: HastElement,
  parseChildren: (children: ReadonlyArray<HastNode>) => Effect.Effect<ReadonlyArray<InlineNode>, ParseResult.ParseError>
): Effect.Effect<InlineNode | null, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const tagName = element.tagName.toLowerCase()

    // Strong/bold
    if (tagName === "strong" || tagName === "b") {
      const children = yield* parseChildrenToBase(element.children, parseChildren)
      return new Strong({ children })
    }

    // Emphasis/italic
    if (tagName === "em" || tagName === "i") {
      const children = yield* parseChildrenToBase(element.children, parseChildren)
      return new Emphasis({ children })
    }

    // Underline
    if (tagName === "u") {
      const children = yield* parseChildrenToBase(element.children, parseChildren)
      return new Underline({ children })
    }

    // Strikethrough
    if (tagName === "del" || tagName === "s") {
      const children = yield* parseChildrenToBase(element.children, parseChildren)
      return new Strikethrough({ children })
    }

    // Subscript
    if (tagName === "sub") {
      const children = yield* parseChildrenToBase(element.children, parseChildren)
      return new Subscript({ children })
    }

    // Superscript
    if (tagName === "sup") {
      const children = yield* parseChildrenToBase(element.children, parseChildren)
      return new Superscript({ children })
    }

    // Inline code
    if (tagName === "code") {
      return new InlineCode({ value: getTextContent(element) })
    }

    // Link
    if (tagName === "a") {
      const href = element.properties?.href as string | undefined
      if (!href) return null
      const children = yield* parseChildrenToBase(element.children, parseChildren)
      return new Link({
        href,
        title: (element.properties?.title as string) || undefined,
        children
      })
    }

    // Line break
    if (tagName === "br") {
      return new LineBreak({})
    }

    // Date/time
    if (tagName === "time") {
      const datetime = (element.properties?.dateTime as string) || ""
      return new DateTime({ datetime })
    }

    // Emoticon (preprocessed from ac:emoticon)
    if (tagName === "span" && element.properties?.["dataEmoji"]) {
      const shortname = (element.properties["dataEmoji"] as string) || ""
      const emojiId = (element.properties["dataEmojiId"] as string) || ""
      const fallback = getTextContent(element)
      return new Emoticon({ shortname, emojiId, fallback })
    }

    // User mention (preprocessed from ac:link > ri:user)
    if (tagName === "span" && element.properties?.["dataUserMention"]) {
      const accountId = (element.properties["dataUserMention"] as string) || ""
      return new UserMention({ accountId })
    }

    // Confluence link with link-body (preprocessed from ac:link > ac:link-body)
    if (tagName === "span" && element.properties?.["dataConfluenceLink"] !== undefined) {
      const linkText = getTextContent(element)
      return new UnsupportedInline({
        raw: `<!--cf:link:${encodeURIComponent(linkText)}-->`,
        source: "confluence"
      })
    }

    // Colored text (span with color style)
    if (tagName === "span") {
      const style = element.properties?.style as string | undefined
      if (style) {
        const colorMatch = style.match(/(?:^|;)\s*color:\s*([^;]+)/)
        const bgMatch = style.match(/(?:^|;)\s*background-color:\s*([^;]+)/)

        if (colorMatch?.[1]) {
          const children = yield* parseChildrenToBase(element.children, parseChildren)
          return new ColoredText({ color: colorMatch[1].trim(), children })
        }

        if (bgMatch?.[1]) {
          const children = yield* parseChildrenToBase(element.children, parseChildren)
          return new Highlight({ backgroundColor: bgMatch[1].trim(), children })
        }
      }

      // Nested span - extract single child
      const children = yield* parseChildren(element.children)
      if (children.length === 1) {
        return children[0] ?? null
      }
      return null
    }

    // Unknown inline element
    return new UnsupportedInline({
      raw: hastElementToHtml(element),
      source: "confluence"
    })
  })

/**
 * Convert AST inline node to HAST node.
 */
export const inlineNodeToHast = (node: InlineNode): HastNode => {
  switch (node._tag) {
    case "Text":
      return makeHastText(node.value)
    case "Strong":
      return makeHastElement("strong", {}, node.children.map(inlineNodeToHast))
    case "Emphasis":
      return makeHastElement("em", {}, node.children.map(inlineNodeToHast))
    case "InlineCode":
      return makeHastElement("code", {}, [makeHastText(node.value)])
    case "Link":
      return makeHastElement(
        "a",
        { href: node.href, ...(node.title ? { title: node.title } : {}) },
        node.children.map(inlineNodeToHast)
      )
    case "LineBreak":
      return makeHastElement("br")
    case "DateTime":
      return makeHastElement("time", { dateTime: node.datetime }, [makeHastText(node.datetime)])
    case "Emoticon":
      return makeHastElement(
        "span",
        { dataEmoji: node.shortname, dataEmojiId: node.emojiId },
        [makeHastText(node.fallback)]
      )
    case "UserMention":
      return makeHastElement("span", { dataUserMention: node.accountId })
    case "Underline":
      return makeHastElement("u", {}, node.children.map(inlineNodeToHast))
    case "Subscript":
      return makeHastElement("sub", {}, node.children.map(inlineNodeToHast))
    case "Superscript":
      return makeHastElement("sup", {}, node.children.map(inlineNodeToHast))
    case "Strikethrough":
      return makeHastElement("del", {}, node.children.map(inlineNodeToHast))
    case "ColoredText":
      return makeHastElement("span", { style: `color: ${node.color}` }, node.children.map(inlineNodeToHast))
    case "Highlight":
      return makeHastElement(
        "span",
        { style: `background-color: ${node.backgroundColor}` },
        node.children.map(inlineNodeToHast)
      )
    case "UnsupportedInline":
      // Return raw HTML wrapped in span
      return makeHastElement("span", { dangerouslySetInnerHTML: node.raw })
  }
}

/**
 * Convert AST inline node to MDAST phrasing content.
 */
export const inlineNodeToMdast = (node: InlineNode): MdastPhrasingContent => {
  switch (node._tag) {
    case "Text":
      return makeMdastText(node.value)
    case "Strong":
      return {
        type: "strong",
        children: node.children.map(inlineNodeToMdast)
      }
    case "Emphasis":
      return {
        type: "emphasis",
        children: node.children.map(inlineNodeToMdast)
      }
    case "InlineCode":
      return {
        type: "inlineCode",
        value: node.value
      }
    case "Link":
      return {
        type: "link",
        url: node.href,
        title: node.title ?? null,
        children: node.children.map(inlineNodeToMdast)
      }
    case "LineBreak":
      return { type: "break" }
    case "DateTime":
      // Markdown doesn't have native datetime - render as text
      return makeMdastText(node.datetime)
    case "Emoticon":
      // Render emoji fallback
      return makeMdastText(node.fallback || node.shortname)
    case "UserMention":
      // Render as @mention text
      return makeMdastText(`@${node.accountId}`)
    case "Underline":
      // Markdown doesn't have underline - render as HTML
      return {
        type: "html",
        value: `<u>${node.children.map((c) => inlineNodeToMdastText(c)).join("")}</u>`
      }
    case "Subscript":
      return {
        type: "html",
        value: `<sub>${node.children.map((c) => inlineNodeToMdastText(c)).join("")}</sub>`
      }
    case "Superscript":
      return {
        type: "html",
        value: `<sup>${node.children.map((c) => inlineNodeToMdastText(c)).join("")}</sup>`
      }
    case "Strikethrough":
      return {
        type: "delete",
        children: node.children.map(inlineNodeToMdast)
      }
    case "ColoredText":
      // Markdown doesn't have colored text - render as plain text
      return makeMdastText(node.children.map((c) => inlineNodeToMdastText(c)).join(""))
    case "Highlight":
      // Markdown doesn't have highlight - render as plain text
      return makeMdastText(node.children.map((c) => inlineNodeToMdastText(c)).join(""))
    case "UnsupportedInline":
      return {
        type: "html",
        value: node.raw
      }
  }
}

/**
 * Base inline node type for children of Strong/Emphasis/Link.
 */
type BaseInlineNode = Text | InlineCode | LineBreak | UnsupportedInline | Emoticon | UserMention | DateTime

/**
 * Convert full InlineNode to base type (for Strong/Emphasis/Link children).
 * Complex nodes are converted to UnsupportedInline.
 */
const toBaseInlineNode = (node: InlineNode): BaseInlineNode => {
  switch (node._tag) {
    case "Text":
    case "InlineCode":
    case "LineBreak":
    case "UnsupportedInline":
    case "Emoticon":
    case "UserMention":
    case "DateTime":
      return node
    case "Strong":
    case "Emphasis":
    case "Link":
    case "Underline":
    case "Subscript":
    case "Superscript":
    case "Strikethrough":
    case "ColoredText":
    case "Highlight":
      // Flatten complex nodes to plain text
      return new Text({ value: inlineNodeToMdastText(node) })
  }
}

/**
 * Convert MDAST phrasing content to AST inline node.
 */
export const inlineNodeFromMdast = (node: MdastPhrasingContent): InlineNode => {
  switch (node.type) {
    case "text":
      return new Text({ value: node.value })
    case "strong":
      return new Strong({ children: node.children.map(inlineNodeFromMdast).map(toBaseInlineNode) })
    case "emphasis":
      return new Emphasis({ children: node.children.map(inlineNodeFromMdast).map(toBaseInlineNode) })
    case "inlineCode":
      return new InlineCode({ value: node.value })
    case "link":
      return new Link({
        href: node.url,
        title: node.title ?? undefined,
        children: node.children.map(inlineNodeFromMdast).map(toBaseInlineNode)
      })
    case "break":
      return new LineBreak({})
    case "image":
      // Inline images become unsupported
      return new UnsupportedInline({
        raw: `![${node.alt ?? ""}](${node.url})`,
        source: "markdown"
      })
    case "delete":
      return new Strikethrough({ children: node.children.map(inlineNodeFromMdast).map(toBaseInlineNode) })
    case "html":
      return new UnsupportedInline({ raw: node.value, source: "markdown" })
    default:
      return new UnsupportedInline({
        raw: JSON.stringify(node),
        source: "markdown"
      })
  }
}

// Helper functions

/**
 * Parse HAST children to base inline nodes (for Strong/Emphasis/Link children).
 */
const parseChildrenToBase = (
  children: ReadonlyArray<HastNode>,
  _parseChildren: (
    children: ReadonlyArray<HastNode>
  ) => Effect.Effect<ReadonlyArray<InlineNode>, ParseResult.ParseError>
): Effect.Effect<ReadonlyArray<Text | InlineCode | LineBreak | UnsupportedInline>, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<Text | InlineCode | LineBreak | UnsupportedInline> = []
    for (const child of children) {
      if (isHastText(child)) {
        nodes.push(new Text({ value: child.value }))
      } else if (isHastElement(child)) {
        const tagName = child.tagName.toLowerCase()
        if (tagName === "code") {
          nodes.push(new InlineCode({ value: getTextContent(child) }))
        } else if (tagName === "br") {
          nodes.push(new LineBreak({}))
        } else {
          nodes.push(new UnsupportedInline({ raw: hastElementToHtml(child), source: "confluence" }))
        }
      }
    }
    return nodes
  })

/**
 * Extract plain text from inline node.
 */
const inlineNodeToMdastText = (node: InlineNode): string => {
  switch (node._tag) {
    case "Text":
      return node.value
    case "InlineCode":
      return node.value
    case "LineBreak":
      return "\n"
    case "DateTime":
      return node.datetime
    case "Emoticon":
      return node.fallback || node.shortname
    case "UserMention":
      return `@${node.accountId}`
    case "Strong":
    case "Emphasis":
    case "Underline":
    case "Subscript":
    case "Superscript":
    case "Strikethrough":
    case "ColoredText":
    case "Highlight":
      return node.children.map(inlineNodeToMdastText).join("")
    case "Link":
      return node.children.map(inlineNodeToMdastText).join("")
    case "UnsupportedInline":
      return ""
  }
}

/**
 * Convert HAST element to HTML string.
 */
const hastElementToHtml = (element: HastElement): string => {
  const props = Object.entries(element.properties || {})
    .map(([k, v]) => {
      const attrName = k.replace(/([A-Z])/g, "-$1").toLowerCase()
      return `${attrName}="${String(v)}"`
    })
    .join(" ")
  const openTag = props ? `<${element.tagName} ${props}>` : `<${element.tagName}>`
  const closeTag = `</${element.tagName}>`
  const content = element.children
    .map((c) => {
      if (isHastText(c)) return c.value
      if (isHastElement(c)) return hastElementToHtml(c)
      return ""
    })
    .join("")
  return `${openTag}${content}${closeTag}`
}

/**
 * Schema-based HAST to InlineNode array transform.
 * This is the main transform schema for parsing inline content from HAST.
 *
 * @category Schemas
 */
export const InlineNodesFromHast = Schema.transformOrFail(
  Schema.Array(Schema.Unknown),
  Schema.Array(Schema.Any),
  {
    strict: false,
    decode: (hastNodes, _options, ast) =>
      Effect.gen(function*() {
        const results: Array<InlineNode> = []

        const parseChildren = (children: ReadonlyArray<HastNode>): Effect.Effect<
          ReadonlyArray<InlineNode>,
          ParseResult.ParseError
        > =>
          Effect.gen(function*() {
            const childResults: Array<InlineNode> = []
            for (const child of children) {
              if (isHastText(child)) {
                childResults.push(textFromHastText(child))
              } else if (isHastElement(child)) {
                const node = yield* inlineNodeFromHastElement(child, parseChildren)
                if (node) childResults.push(node)
              }
            }
            return childResults
          })

        for (const hastNode of hastNodes) {
          if (isHastText(hastNode as HastNode)) {
            results.push(textFromHastText(hastNode as HastText))
          } else if (isHastElement(hastNode as HastNode)) {
            const node = yield* inlineNodeFromHastElement(hastNode as HastElement, parseChildren)
            if (node) results.push(node)
          }
        }

        return results
      }).pipe(
        Effect.mapError((e) =>
          e instanceof ParseResult.ParseError
            ? e.issue
            : new ParseResult.Type(ast, hastNodes, String(e))
        )
      ),
    encode: (nodes, _options, _ast) => Effect.succeed(nodes.map(inlineNodeToHast) as ReadonlyArray<unknown>)
  }
)

/**
 * Schema-based MDAST to InlineNode array transform.
 *
 * @category Schemas
 */
export const InlineNodesFromMdast = Schema.transformOrFail(
  Schema.Array(Schema.Unknown),
  Schema.Array(Schema.Any),
  {
    strict: false,
    decode: (mdastNodes, _options, _ast) =>
      Effect.succeed(mdastNodes.map((n) => inlineNodeFromMdast(n as MdastPhrasingContent))),
    encode: (nodes, _options, _ast) => Effect.succeed(nodes.map(inlineNodeToMdast) as ReadonlyArray<unknown>)
  }
)

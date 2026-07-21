import type { ReactElement, ReactNode } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

const safeExternalUrl = (value: string): string => {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === ""
      ? value
      : ""
  } catch {
    return ""
  }
}

interface MarkdownNode {
  children?: Array<MarkdownNode> | undefined
  position?:
    | {
        end: { offset?: number | undefined }
        start: { offset?: number | undefined }
      }
    | undefined
  type: string
}

const preserveLiteralUrls =
  () =>
  (tree: MarkdownNode, file: { readonly value: unknown }): void => {
    if (typeof file.value !== "string") return
    const source = file.value
    const visit = (node: MarkdownNode): void => {
      const children = node.children
      if (children === undefined) return
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]
        const start = child?.position?.start.offset
        const end = child?.position?.end.offset
        const markdown = start === undefined || end === undefined ? "" : source.slice(start, end)
        if (child?.type === "link" && !markdown.startsWith("[") && !markdown.startsWith("<")) {
          children.splice(index, 1, ...(child.children ?? []))
          index -= 1
        } else if (child !== undefined) {
          visit(child)
        }
      }
    }
    visit(tree)
  }

const Heading = ({ children, level }: { readonly children: ReactNode; readonly level: 3 | 4 | 5 | 6 }) => {
  if (level === 3) return <h3>{children}</h3>
  if (level === 4) return <h4>{children}</h4>
  if (level === 5) return <h5>{children}</h5>
  return <h6>{children}</h6>
}

/** Render bounded normalized rich text as a safe semantic document fragment. */
export const WorkspaceRichText = ({
  className,
  value
}: {
  readonly className?: string | undefined
  readonly value: string
}): ReactElement => (
  <div className={className} data-workspace-rich-text>
    <Markdown
      allowedElements={[
        "a",
        "blockquote",
        "br",
        "code",
        "del",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "li",
        "ol",
        "p",
        "pre",
        "strong",
        "ul"
      ]}
      components={{
        a: ({ children, href }) =>
          href === undefined || href.length === 0 ? (
            <>{children}</>
          ) : (
            <a href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          ),
        h1: ({ children }) => <Heading level={3}>{children}</Heading>,
        h2: ({ children }) => <Heading level={3}>{children}</Heading>,
        h3: ({ children }) => <Heading level={4}>{children}</Heading>,
        h4: ({ children }) => <Heading level={5}>{children}</Heading>,
        h5: ({ children }) => <Heading level={6}>{children}</Heading>,
        h6: ({ children }) => <Heading level={6}>{children}</Heading>
      }}
      skipHtml
      remarkPlugins={[remarkGfm, preserveLiteralUrls]}
      urlTransform={safeExternalUrl}
    >
      {value}
    </Markdown>
  </div>
)

import { Button, Field, StatePanel, Text } from "@knpkv/rly/primitives"
import { type ReactElement, useEffect, useRef, useState } from "react"

import type { EntityId, ReleaseId } from "../../domain/identifiers.js"
import { confluenceTaskSummary, setConfluenceTaskChecked } from "../../domain/confluenceTasks.js"
import { submitBrowserReleasePublication } from "../releases/releaseAgentTransport.js"
import type { WorkspaceConfluencePagePresentation } from "./presentWorkspaceConfluencePage.js"
import { WorkspaceRichText } from "./WorkspaceRichText.js"
import styles from "./WorkspaceConfluencePageDetails.module.css"

type EditorState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "editing" }
  | { readonly _tag: "saving" }
  | { readonly _tag: "saved" }
  | { readonly _tag: "failed" }

const markdownEscape = (value: string): string => value.replace(/([\\`*_[\]<>])/gu, "\\$1")
const isElementNode = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE

const inlineMarkdown = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return markdownEscape(node.textContent ?? "")
  if (!isElementNode(node)) return ""
  const content = [...node.childNodes].map(inlineMarkdown).join("")
  switch (node.tagName.toLocaleLowerCase("en-US")) {
    case "strong":
    case "b":
      return `**${content}**`
    case "em":
    case "i":
      return `*${content}*`
    case "s":
    case "del":
      return `~~${content}~~`
    case "code":
      return `\`${(node.textContent ?? "").replace(/`/gu, "\\`")}\``
    case "a": {
      const href = node.getAttribute("href")
      return href === null ? content : `[${content}](${href.replace(/\)/gu, "\\)")})`
    }
    case "br":
      return "  \n"
    default:
      return content
  }
}

const listMarkdown = (element: Element, ordered: boolean): string =>
  [...element.children]
    .filter((child) => child.tagName.toLocaleLowerCase("en-US") === "li")
    .map((child, index) => `${ordered ? `${String(index + 1)}.` : "-"} ${inlineMarkdown(child).trim()}`)
    .join("\n")

const blockMarkdown = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return markdownEscape(node.textContent ?? "")
  if (!isElementNode(node)) return ""
  const tag = node.tagName.toLocaleLowerCase("en-US")
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${"#".repeat(Number(tag.slice(1)))} ${inlineMarkdown(node).trim()}`
    case "ul":
      return listMarkdown(node, false)
    case "ol":
      return listMarkdown(node, true)
    case "blockquote":
      return inlineMarkdown(node)
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    case "pre":
      return `\`\`\`\n${node.textContent ?? ""}\n\`\`\``
    case "hr":
      return "---"
    case "p":
    case "div":
    case "section":
    case "article": {
      const blockChildren = [...node.children].some((child) =>
        /^(?:article|blockquote|div|h[1-6]|hr|ol|p|pre|section|ul)$/u.test(child.tagName.toLocaleLowerCase("en-US"))
      )
      return blockChildren
        ? [...node.childNodes]
            .map(blockMarkdown)
            .filter((part) => part.trim().length > 0)
            .join("\n\n")
        : inlineMarkdown(node).trim()
    }
    default:
      return inlineMarkdown(node).trim()
  }
}

/** Serialize only the semantic subset rendered by WorkspaceRichText; provider HTML never crosses this boundary. */
export const confluenceEditorMarkdown = (root: HTMLElement): string =>
  [...root.childNodes]
    .map(blockMarkdown)
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()

const runEditorCommand = (command: string, value?: string): void => {
  document.execCommand(command, false, value)
}

export interface WorkspaceConfluenceVisualEditorProps {
  readonly canEdit: boolean
  readonly entityId: EntityId
  readonly onAskAgent: () => void
  readonly onSaved: () => void
  readonly page: WorkspaceConfluencePagePresentation
  readonly releaseId: ReleaseId | null
  readonly submitPublication?: typeof submitBrowserReleasePublication
  readonly title: string
}

/** In-place, revision-guarded visual editing for one synchronized Confluence page. */
export const WorkspaceConfluenceVisualEditor = ({
  canEdit,
  entityId,
  onAskAgent,
  onSaved,
  page,
  releaseId,
  submitPublication = submitBrowserReleasePublication,
  title
}: WorkspaceConfluenceVisualEditorProps): ReactElement => {
  const [state, setState] = useState<EditorState>({ _tag: "idle" })
  const [taskLineSaving, setTaskLineSaving] = useState<number | null>(null)
  const [taskSaveFailed, setTaskSaveFailed] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title)
  const editorRef = useRef<HTMLDivElement>(null)
  const editing = state._tag !== "idle" && state._tag !== "saved"
  const busy = state._tag === "saving"
  const taskSummary = confluenceTaskSummary(page.content ?? "")

  useEffect(() => {
    setDraftTitle(title)
    setState({ _tag: "idle" })
    setTaskLineSaving(null)
    setTaskSaveFailed(false)
  }, [page.revision, title])

  const setTaskChecked = (lineIndex: number, checked: boolean): void => {
    if (!canEdit || releaseId === null || page.content === null || taskLineSaving !== null) return
    const markdown = setConfluenceTaskChecked(page.content, lineIndex, checked)
    if (markdown === null) return
    setTaskLineSaving(lineIndex)
    setTaskSaveFailed(false)
    submitPublication({
      releaseId,
      provider: "confluence",
      title,
      markdown,
      targetEntityId: entityId
    })
      .then(
        () => onSaved(),
        () => setTaskSaveFailed(true)
      )
      .finally(() => setTaskLineSaving(null))
  }

  const save = (): void => {
    const editor = editorRef.current
    if (editor === null || releaseId === null || busy) return
    const markdown = confluenceEditorMarkdown(editor)
    const normalizedTitle = draftTitle.trim()
    if (normalizedTitle.length === 0 || markdown.length === 0) {
      setState({ _tag: "failed" })
      return
    }
    setState({ _tag: "saving" })
    submitPublication({
      releaseId,
      provider: "confluence",
      title: normalizedTitle,
      markdown,
      targetEntityId: entityId
    }).then(
      () => {
        setState({ _tag: "saved" })
        onSaved()
      },
      () => setState({ _tag: "failed" })
    )
  }

  if (!editing) {
    return (
      <div className={styles.documentRead}>
        {page.contentState === "loaded" && page.content !== null ? (
          <WorkspaceRichText className={styles.richText} value={page.content} />
        ) : (
          <div className={styles.contentState} data-content-state={page.contentState}>
            <strong>
              {page.contentState === "lazy" ? "Content has not been loaded" : "No readable body was returned"}
            </strong>
            <Text tone="secondary">
              Open the authenticated Confluence source to read it now, or synchronize the connection before editing so
              Relay never replaces an unseen document.
            </Text>
          </div>
        )}
        {taskSummary.total === 0 ? null : (
          <section aria-labelledby="confluence-release-tasks" className={styles.releaseTasks}>
            <div className={styles.releaseTaskHeading}>
              <Text as="h3" id="confluence-release-tasks" variant="card-title">
                Release tasks
              </Text>
              <Text tone="secondary" variant="meta">
                {taskSummary.completed} of {taskSummary.total} complete
              </Text>
            </div>
            <ul className={styles.releaseTaskList}>
              {taskSummary.tasks.map((task) => (
                <li key={`${String(task.lineIndex)}-${task.label}`}>
                  <label>
                    <input
                      checked={task.checked}
                      disabled={!canEdit || releaseId === null || taskLineSaving !== null}
                      onChange={(event) => setTaskChecked(task.lineIndex, event.target.checked)}
                      type="checkbox"
                    />
                    <span>{task.label}</span>
                  </label>
                  {taskLineSaving === task.lineIndex ? <Text variant="meta">Saving…</Text> : null}
                </li>
              ))}
            </ul>
            {taskSummary.outstanding === 0 ? (
              <Text>All Confluence tasks are complete.</Text>
            ) : (
              <Text tone="secondary">
                {taskSummary.outstanding} task{taskSummary.outstanding === 1 ? "" : "s"} block release publication.
              </Text>
            )}
            {taskSaveFailed ? (
              <StatePanel
                description="Refresh the latest Confluence revision, then tick the task again."
                title="The task was not updated"
                tone="critical"
              />
            ) : null}
          </section>
        )}
        <div className={styles.editorEntry}>
          <Button disabled={!canEdit || releaseId === null} onClick={() => setState({ _tag: "editing" })}>
            {page.contentState === "loaded" && page.content !== null
              ? "Edit on this page"
              : "Write a complete replacement"}
          </Button>
          <Button onClick={onAskAgent} variant="secondary">
            Ask Relay to edit
          </Button>
          {state._tag === "saved" ? <Text>Saved to Confluence.</Text> : null}
          {!canEdit ? (
            <Text tone="secondary">Current source data and workspace-owner access are required to edit.</Text>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.visualEditor} data-confluence-visual-editor>
      <div className={styles.editorHeading}>
        <div>
          <Text as="strong">Editing revision {page.revision}</Text>
          <Text tone="secondary" variant="meta">
            Save creates the next Confluence revision after an explicit owner confirmation.
          </Text>
        </div>
        <div className={styles.editorActions}>
          <Button disabled={busy} onClick={onAskAgent} variant="secondary">
            Ask Relay
          </Button>
          <Button disabled={busy} onClick={() => setState({ _tag: "idle" })} variant="secondary">
            Cancel
          </Button>
          <Button disabled={busy} loading={busy} onClick={save}>
            Save to Confluence
          </Button>
        </div>
      </div>
      {page.contentState !== "loaded" || page.content === null ? (
        <StatePanel
          description="The existing body is not synchronized. Saving this draft replaces the complete Confluence page body at the displayed revision."
          title="Complete replacement"
          tone="caution"
        />
      ) : null}
      <Field label="Page title">
        {(controlProps) => (
          <input
            {...controlProps}
            disabled={busy}
            maxLength={500}
            onChange={(event) => setDraftTitle(event.target.value)}
            value={draftTitle}
          />
        )}
      </Field>
      <div
        aria-label="Document formatting"
        className={styles.editorToolbar}
        onMouseDown={(event) => event.preventDefault()}
        role="toolbar"
      >
        <button onClick={() => runEditorCommand("formatBlock", "p")} type="button">
          Paragraph
        </button>
        <button onClick={() => runEditorCommand("formatBlock", "h2")} type="button">
          Heading 2
        </button>
        <button onClick={() => runEditorCommand("formatBlock", "h3")} type="button">
          Heading 3
        </button>
        <button aria-label="Bold" onClick={() => runEditorCommand("bold")} type="button">
          <strong>B</strong>
        </button>
        <button aria-label="Italic" onClick={() => runEditorCommand("italic")} type="button">
          <em>I</em>
        </button>
        <button onClick={() => runEditorCommand("insertUnorderedList")} type="button">
          Bullets
        </button>
        <button onClick={() => runEditorCommand("insertOrderedList")} type="button">
          Numbered
        </button>
        <button
          onClick={() => {
            const href = window.prompt("Link address")
            if (href !== null && URL.canParse(href)) runEditorCommand("createLink", href)
          }}
          type="button"
        >
          Link
        </button>
      </div>
      <div
        aria-label="Confluence page body"
        className={`${styles.editorCanvas} ${styles.richText}`}
        contentEditable={!busy}
        ref={editorRef}
        role="textbox"
        suppressContentEditableWarning
      >
        <WorkspaceRichText value={page.content ?? ""} />
      </div>
      {state._tag === "failed" ? (
        <StatePanel
          description="Keep a non-empty title and document body, refresh the latest revision, then try again."
          title="The page was not saved"
          tone="critical"
        />
      ) : null}
    </div>
  )
}

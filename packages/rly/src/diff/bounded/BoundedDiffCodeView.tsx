"use client"

import {
  type ChangeContent,
  type ContextContent,
  type FileDiffMetadata,
  type Hunk,
  parseDiffFromFile
} from "@pierre/diffs"
import type { ReactElement, ReactNode } from "react"
import { cssClass } from "../../internal/component.js"
import type { RlyDiffCodeItem } from "../types.js"
import styles from "./BoundedDiffCodeView.module.css"

export type { RlyDiffCodeItem } from "../types.js"

type BoundedDiffMode = "split" | "stacked"

interface DiffLine {
  readonly content: string
  readonly number: number
}

type SplitRow =
  | {
      readonly addition?: DiffLine
      readonly deletion?: DiffLine
      readonly kind: "change" | "context"
    }
  | {
      readonly kind: "hunk"
      readonly label: string
    }

type UnifiedRow =
  | {
      readonly additionNumber?: number
      readonly content: string
      readonly deletionNumber?: number
      readonly kind: "addition" | "context" | "deletion"
    }
  | {
      readonly kind: "hunk"
      readonly label: string
    }

/** Props for the strict-budget, main-thread line diff renderer. */
export interface BoundedDiffCodeViewProps {
  readonly className?: string
  readonly empty?: ReactNode
  readonly initialItems: ReadonlyArray<RlyDiffCodeItem>
  readonly mode?: BoundedDiffMode
  readonly wrap?: boolean
}

const contentAt = (lines: ReadonlyArray<string>, index: number): string => lines[index]?.replace(/\n$/, "") ?? ""

const hunkLabel = (hunk: Hunk): string =>
  hunk.hunkSpecs?.trim() ??
  `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`

const parseItem = (item: RlyDiffCodeItem): FileDiffMetadata | undefined => {
  if (item.before.contents === item.after.contents) return undefined
  return parseDiffFromFile(
    {
      ...(item.before.cacheKey === undefined ? {} : { cacheKey: item.before.cacheKey }),
      contents: item.before.contents,
      name: item.before.name
    },
    {
      ...(item.after.cacheKey === undefined ? {} : { cacheKey: item.after.cacheKey }),
      contents: item.after.contents,
      name: item.after.name
    },
    undefined,
    true
  )
}

const contextSplitRows = (diff: FileDiffMetadata, content: ContextContent): ReadonlyArray<SplitRow> =>
  Array.from({ length: content.lines }, (_, offset) => ({
    addition: {
      content: contentAt(diff.additionLines, content.additionLineIndex + offset),
      number: content.additionLineIndex + offset + 1
    },
    deletion: {
      content: contentAt(diff.deletionLines, content.deletionLineIndex + offset),
      number: content.deletionLineIndex + offset + 1
    },
    kind: "context"
  }))

const changeSplitRows = (diff: FileDiffMetadata, content: ChangeContent): ReadonlyArray<SplitRow> =>
  Array.from({ length: Math.max(content.deletions, content.additions) }, (_, offset) => ({
    ...(offset < content.additions
      ? {
          addition: {
            content: contentAt(diff.additionLines, content.additionLineIndex + offset),
            number: content.additionLineIndex + offset + 1
          }
        }
      : {}),
    ...(offset < content.deletions
      ? {
          deletion: {
            content: contentAt(diff.deletionLines, content.deletionLineIndex + offset),
            number: content.deletionLineIndex + offset + 1
          }
        }
      : {}),
    kind: "change"
  }))

const splitRows = (diff: FileDiffMetadata): ReadonlyArray<SplitRow> =>
  diff.hunks.flatMap((hunk) => [
    { kind: "hunk", label: hunkLabel(hunk) },
    ...hunk.hunkContent.flatMap((content) =>
      content.type === "context" ? contextSplitRows(diff, content) : changeSplitRows(diff, content)
    )
  ])

const unifiedRows = (diff: FileDiffMetadata): ReadonlyArray<UnifiedRow> =>
  diff.hunks.flatMap((hunk) => [
    { kind: "hunk", label: hunkLabel(hunk) },
    ...hunk.hunkContent.flatMap((content): ReadonlyArray<UnifiedRow> => {
      if (content.type === "context") {
        return Array.from({ length: content.lines }, (_, offset) => ({
          additionNumber: content.additionLineIndex + offset + 1,
          content: contentAt(diff.additionLines, content.additionLineIndex + offset),
          deletionNumber: content.deletionLineIndex + offset + 1,
          kind: "context"
        }))
      }
      return [
        ...Array.from({ length: content.deletions }, (_, offset): UnifiedRow => ({
          content: contentAt(diff.deletionLines, content.deletionLineIndex + offset),
          deletionNumber: content.deletionLineIndex + offset + 1,
          kind: "deletion"
        })),
        ...Array.from({ length: content.additions }, (_, offset): UnifiedRow => ({
          additionNumber: content.additionLineIndex + offset + 1,
          content: contentAt(diff.additionLines, content.additionLineIndex + offset),
          kind: "addition"
        }))
      ]
    })
  ])

const code = (content: string, wrap: boolean): ReactElement => (
  <code className={wrap ? styles.wrappedCode : styles.code}>{content.length === 0 ? " " : content}</code>
)

const renderSplit = (diff: FileDiffMetadata, wrap: boolean): ReactElement => (
  <table aria-label={`Changes in ${diff.name}`} className={styles.table}>
    <tbody>
      {splitRows(diff).map((row, index) =>
        row.kind === "hunk" ? (
          <tr className={styles.hunk} key={`${index}:${row.label}`}>
            <td colSpan={4}>{row.label}</td>
          </tr>
        ) : (
          <tr className={styles[row.kind]} key={`${index}:${row.deletion?.number ?? ""}:${row.addition?.number ?? ""}`}>
            <td className={styles.lineNumber}>{row.deletion?.number}</td>
            <td className={styles.deletionCode}>
              {row.deletion === undefined ? null : code(row.deletion.content, wrap)}
            </td>
            <td className={styles.lineNumber}>{row.addition?.number}</td>
            <td className={styles.additionCode}>
              {row.addition === undefined ? null : code(row.addition.content, wrap)}
            </td>
          </tr>
        )
      )}
    </tbody>
  </table>
)

const renderUnified = (diff: FileDiffMetadata, wrap: boolean): ReactElement => (
  <table aria-label={`Changes in ${diff.name}`} className={styles.table}>
    <tbody>
      {unifiedRows(diff).map((row, index) =>
        row.kind === "hunk" ? (
          <tr className={styles.hunk} key={`${index}:${row.label}`}>
            <td colSpan={4}>{row.label}</td>
          </tr>
        ) : (
          <tr className={styles[row.kind]} key={`${index}:${row.deletionNumber ?? ""}:${row.additionNumber ?? ""}`}>
            <td className={styles.lineNumber}>{row.deletionNumber}</td>
            <td className={styles.lineNumber}>{row.additionNumber}</td>
            <td className={styles.marker}>{row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : " "}</td>
            <td>{code(row.content, wrap)}</td>
          </tr>
        )
      )}
    </tbody>
  </table>
)

/**
 * Render complete line changes using Diffs' parser without syntax packs or a WASM worker.
 *
 * The public shape is deliberately small so syntax highlighting and virtualized rendering
 * can be added later without changing Control Center's diff data contract.
 */
export const BoundedDiffCodeView = ({
  className,
  empty = "No renderable source changes.",
  initialItems,
  mode = "split",
  wrap = false
}: BoundedDiffCodeViewProps): ReactNode => {
  if (initialItems.length === 0) return <p className={className}>{empty}</p>

  return (
    <div
      className={className === undefined ? cssClass(styles, "root") : `${cssClass(styles, "root")} ${className}`}
      data-rly-diff-code-view=""
      data-rly-diff-mode={mode}
    >
      {initialItems.map((item) => {
        const diff = parseItem(item)
        if (diff === undefined) {
          return (
            <p className={styles.noChanges} key={item.id}>
              No textual changes in this file.
            </p>
          )
        }
        return (
          <section className={styles.file} key={item.id}>
            {initialItems.length > 1 ? <h3 className={styles.fileName}>{diff.name}</h3> : null}
            <div className={styles.scroller}>
              {mode === "split" ? renderSplit(diff, wrap) : renderUnified(diff, wrap)}
            </div>
          </section>
        )
      })}
    </div>
  )
}

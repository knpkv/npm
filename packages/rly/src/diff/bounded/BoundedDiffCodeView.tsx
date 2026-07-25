"use client"

import {
  type ChangeContent,
  type ContextContent,
  type FileDiffMetadata,
  type Hunk,
  parseDiffFromFile
} from "@pierre/diffs"
import { Fragment, type ReactElement, type ReactNode, useRef } from "react"
import { cssClass } from "../../internal/component.js"
import { DiffCodeAnnotation, requireDiffCodeAnnotations } from "../annotation.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem } from "../types.js"
import styles from "./BoundedDiffCodeView.module.css"

export type {
  RlyDiffCodeAnnotation,
  RlyDiffCodeAnnotationLocation,
  RlyDiffCodeAnnotationRenderContext,
  RlyDiffCodeItem
} from "../types.js"

type BoundedDiffMode = "split" | "stacked"

interface BoundedAnnotationLocation {
  readonly lineNumber: number
  readonly side: "additions" | "deletions"
}

const boundedAnnotationLocation = (
  lineNumber: number,
  side: BoundedAnnotationLocation["side"]
): BoundedAnnotationLocation => ({ lineNumber, side })

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
  readonly annotations?: ReadonlyArray<RlyDiffCodeAnnotation>
  readonly className?: string
  readonly empty?: ReactNode
  readonly initialItems: ReadonlyArray<RlyDiffCodeItem>
  readonly mode?: BoundedDiffMode
  readonly wrap?: boolean
}

const contentAt = (lines: ReadonlyArray<string>, index: number): string => lines[index]?.replace(/\r?\n$/, "") ?? ""

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

const code = (
  content: string,
  itemId: string,
  lineNumber: number,
  side: "additions" | "deletions",
  wrap: boolean,
  alternate?: { readonly lineNumber: number; readonly side: "additions" | "deletions" }
): ReactElement => (
  <code
    className={wrap ? styles.wrappedCode : styles.code}
    data-rly-diff-item={itemId}
    {...(alternate === undefined
      ? {}
      : {
          "data-rly-diff-line-alternate": alternate.lineNumber,
          "data-rly-diff-line-side-alternate": alternate.side
        })}
    data-rly-diff-line={lineNumber}
    data-rly-diff-line-side={side}
    tabIndex={-1}
  >
    {content.length === 0 ? " " : content}
  </code>
)

const focusBoundedLine = (
  root: HTMLDivElement | null,
  itemId: string,
  lineNumber: number,
  side: "additions" | "deletions"
): void => {
  const line = [...(root?.querySelectorAll<HTMLElement>("[data-rly-diff-line]") ?? [])].find(
    (candidate) =>
      candidate.dataset.rlyDiffItem === itemId &&
      ((candidate.dataset.rlyDiffLine === String(lineNumber) && candidate.dataset.rlyDiffLineSide === side) ||
        (candidate.dataset.rlyDiffLineAlternate === String(lineNumber) &&
          candidate.dataset.rlyDiffLineSideAlternate === side))
  )
  line?.focus({ preventScroll: true })
}

const annotationsAt = (
  annotations: ReadonlyArray<RlyDiffCodeAnnotation>,
  itemId: string,
  lineNumber: number | undefined,
  side: "additions" | "deletions"
): ReadonlyArray<RlyDiffCodeAnnotation> =>
  lineNumber === undefined
    ? []
    : annotations.filter(
        (annotation) =>
          annotation.location.itemId === itemId &&
          annotation.location.lineNumber === lineNumber &&
          annotation.location.side === side
      )

const splitAnnotationRows = (
  annotations: ReadonlyArray<RlyDiffCodeAnnotation>,
  itemId: string,
  row: Extract<SplitRow, { readonly kind: "change" | "context" }>,
  root: () => HTMLDivElement | null
): ReadonlyArray<ReactElement> => [
  ...annotationsAt(annotations, itemId, row.deletion?.number, "deletions").map((annotation) => (
    <tr className={styles.annotationRow} key={annotation.id}>
      <td className={styles.annotationCell} colSpan={2}>
        <DiffCodeAnnotation
          annotation={annotation}
          className={cssClass(styles, "annotation")}
          returnFocus={() => focusBoundedLine(root(), itemId, annotation.location.lineNumber, annotation.location.side)}
        />
      </td>
      <td colSpan={2} />
    </tr>
  )),
  ...annotationsAt(annotations, itemId, row.addition?.number, "additions").map((annotation) => (
    <tr className={styles.annotationRow} key={annotation.id}>
      <td colSpan={2} />
      <td className={styles.annotationCell} colSpan={2}>
        <DiffCodeAnnotation
          annotation={annotation}
          className={cssClass(styles, "annotation")}
          returnFocus={() => focusBoundedLine(root(), itemId, annotation.location.lineNumber, annotation.location.side)}
        />
      </td>
    </tr>
  ))
]

const renderSplit = (
  diff: FileDiffMetadata,
  itemId: string,
  annotations: ReadonlyArray<RlyDiffCodeAnnotation>,
  root: () => HTMLDivElement | null,
  wrap: boolean
): ReactElement => (
  <table aria-label={`Changes in ${diff.name}`} className={styles.table}>
    <tbody>
      {splitRows(diff).map((row, index) =>
        row.kind === "hunk" ? (
          <tr className={styles.hunk} key={`${index}:${row.label}`}>
            <td colSpan={4}>{row.label}</td>
          </tr>
        ) : (
          <Fragment key={`${index}:${row.deletion?.number ?? ""}:${row.addition?.number ?? ""}`}>
            <tr className={styles[row.kind]}>
              <td className={styles.lineNumber}>{row.deletion?.number}</td>
              <td className={styles.deletionCode}>
                {row.deletion === undefined
                  ? null
                  : code(row.deletion.content, itemId, row.deletion.number, "deletions", wrap)}
              </td>
              <td className={styles.lineNumber}>{row.addition?.number}</td>
              <td className={styles.additionCode}>
                {row.addition === undefined
                  ? null
                  : code(row.addition.content, itemId, row.addition.number, "additions", wrap)}
              </td>
            </tr>
            {splitAnnotationRows(annotations, itemId, row, root)}
          </Fragment>
        )
      )}
    </tbody>
  </table>
)

const unifiedAnnotationRows = (
  annotations: ReadonlyArray<RlyDiffCodeAnnotation>,
  itemId: string,
  row: Extract<UnifiedRow, { readonly kind: "addition" | "context" | "deletion" }>,
  root: () => HTMLDivElement | null
): ReadonlyArray<ReactElement> => {
  const locations: ReadonlyArray<BoundedAnnotationLocation> = [
    ...(row.deletionNumber === undefined ? [] : [boundedAnnotationLocation(row.deletionNumber, "deletions")]),
    ...(row.additionNumber === undefined ? [] : [boundedAnnotationLocation(row.additionNumber, "additions")])
  ]
  return locations.flatMap(({ lineNumber, side }) =>
    annotationsAt(annotations, itemId, lineNumber, side).map((annotation) => (
      <tr className={styles.annotationRow} key={annotation.id}>
        <td className={styles.annotationCell} colSpan={4}>
          <DiffCodeAnnotation
            annotation={annotation}
            className={cssClass(styles, "annotation")}
            returnFocus={() => focusBoundedLine(root(), itemId, lineNumber, side)}
          />
        </td>
      </tr>
    ))
  )
}

const renderUnified = (
  diff: FileDiffMetadata,
  itemId: string,
  annotations: ReadonlyArray<RlyDiffCodeAnnotation>,
  root: () => HTMLDivElement | null,
  wrap: boolean
): ReactElement => (
  <table aria-label={`Changes in ${diff.name}`} className={styles.table}>
    <tbody>
      {unifiedRows(diff).map((row, index) =>
        row.kind === "hunk" ? (
          <tr className={styles.hunk} key={`${index}:${row.label}`}>
            <td colSpan={4}>{row.label}</td>
          </tr>
        ) : (
          <Fragment key={`${index}:${row.deletionNumber ?? ""}:${row.additionNumber ?? ""}`}>
            <tr className={styles[row.kind]}>
              <td className={styles.lineNumber}>{row.deletionNumber}</td>
              <td className={styles.lineNumber}>{row.additionNumber}</td>
              <td className={styles.marker}>{row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : " "}</td>
              <td>
                {code(
                  row.content,
                  itemId,
                  row.kind === "deletion" ? (row.deletionNumber ?? 0) : (row.additionNumber ?? 0),
                  row.kind === "deletion" ? "deletions" : "additions",
                  wrap,
                  row.kind === "context" && row.deletionNumber !== undefined
                    ? { lineNumber: row.deletionNumber, side: "deletions" }
                    : undefined
                )}
              </td>
            </tr>
            {unifiedAnnotationRows(annotations, itemId, row, root)}
          </Fragment>
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
  annotations = [],
  className,
  empty = "No renderable source changes.",
  initialItems,
  mode = "split",
  wrap = false
}: BoundedDiffCodeViewProps): ReactNode => {
  requireDiffCodeAnnotations(annotations)
  const rootRef = useRef<HTMLDivElement>(null)
  if (initialItems.length === 0) return <p className={className}>{empty}</p>

  return (
    <div
      ref={rootRef}
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
              {mode === "split"
                ? renderSplit(diff, item.id, annotations, () => rootRef.current, wrap)
                : renderUnified(diff, item.id, annotations, () => rootRef.current, wrap)}
            </div>
          </section>
        )
      })}
    </div>
  )
}

import { Fragment, type ReactElement, type ReactNode } from "react"
import styles from "../bounded/BoundedDiffCodeView.module.css"
import type { DiffLine, FileDiff, Hunk } from "./parse.js"

export { findFile, parsePatch, pathsOf } from "./parse.js"
export type { DiffLine, FileDiff, FileStatus, Hunk, LineKind, ParseResult, Patch, PatchInvalid } from "./parse.js"

export interface PatchDiffViewProps {
  readonly file: FileDiff
  /** Unique prefix for stable source-line links within the document. */
  readonly id: string
  readonly mode?: "split" | "stacked"
  readonly wrap?: boolean
  /** Called once for each visible side and line; consumers own annotation identity and content. */
  readonly renderAnnotation?: (side: "old" | "new", line: number) => ReactNode
}

interface Row {
  readonly left: DiffLine | undefined
  readonly right: DiffLine | undefined
}

/** Pair consecutive deletions and additions without renumbering sparse patch hunks. */
export const pairRows = (hunk: Hunk): ReadonlyArray<Row> => {
  const rows: Array<Row> = []
  let index = 0
  while (index < hunk.lines.length) {
    const line = hunk.lines[index]
    if (line === undefined) break
    if (line.kind === "context") {
      rows.push({ left: line, right: line })
      index++
      continue
    }
    const deleted: Array<DiffLine> = []
    const added: Array<DiffLine> = []
    while (hunk.lines[index]?.kind === "del") {
      const next = hunk.lines[index++]
      if (next !== undefined) deleted.push(next)
    }
    while (hunk.lines[index]?.kind === "add") {
      const next = hunk.lines[index++]
      if (next !== undefined) added.push(next)
    }
    for (let offset = 0; offset < Math.max(deleted.length, added.length); offset++) {
      const left = deleted[offset]
      const right = added[offset]
      rows.push({ left, right })
    }
  }
  return rows
}

/** Render a patch as an accessible, server-renderable table. Source omissions stay omitted. */
export const PatchDiffView = ({
  file,
  id,
  mode = "split",
  renderAnnotation,
  wrap = false
}: PatchDiffViewProps): ReactElement => {
  const cell = (line: DiffLine | undefined, side: "old" | "new") => {
    const number = side === "old" ? line?.oldNo : line?.newNo
    return (
      <>
        <td className={styles.lineNumber}>{number}</td>
        <td className={side === "old" ? styles.deletionCode : styles.additionCode}>
          {line === undefined ? null : (
            <code className={wrap ? styles.wrappedCode : styles.code} id={`${id}-${side}-${number}`} tabIndex={-1}>
              {line.text || " "}
            </code>
          )}
        </td>
      </>
    )
  }
  const annotation = (line: DiffLine | undefined, side: "old" | "new") => {
    const number = side === "old" ? line?.oldNo : line?.newNo
    const content = number === undefined ? undefined : renderAnnotation?.(side, number)
    return content == null ? null : (
      <tr className={styles.annotationRow}>
        <td className={styles.annotationCell} colSpan={4}>
          {content}
        </td>
      </tr>
    )
  }
  return (
    <div className={styles.root} data-rly-patch-diff="" data-rly-diff-mode={mode}>
      {file.binary || file.hunks.length === 0 ? (
        <p className={styles.noChanges}>{file.binary ? "Binary file." : "No content change."}</p>
      ) : (
        <div style={{ overflowX: "auto" }} role="region" aria-label={`Changes in ${file.path}`} tabIndex={0}>
          <table className={styles.table} aria-label={`Changes in ${file.path}`}>
            <thead>
              <tr>
                {mode === "split" ? (
                  <>
                    <th colSpan={2} scope="colgroup">
                      Before
                    </th>
                    <th colSpan={2} scope="colgroup">
                      After
                    </th>
                  </>
                ) : (
                  <>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                    <th colSpan={2} scope="colgroup">
                      Change
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {file.hunks.map((hunk, hunkIndex) => (
                <Fragment key={hunkIndex}>
                  <tr className={styles.hunk}>
                    <td colSpan={4}>
                      @@ {hunk.oldStart} → {hunk.newStart} {hunk.header}
                    </td>
                  </tr>
                  {mode === "split"
                    ? pairRows(hunk).map((row, rowIndex) => (
                        <Fragment key={rowIndex}>
                          <tr className={row.left?.kind === "context" ? styles.context : styles.change}>
                            {cell(row.left, "old")}
                            {cell(row.right, "new")}
                          </tr>
                          {annotation(row.left, "old")}
                          {annotation(row.right, "new")}
                        </Fragment>
                      ))
                    : hunk.lines.map((line, lineIndex) => (
                        <Fragment key={lineIndex}>
                          <tr
                            className={
                              line.kind === "add"
                                ? styles.addition
                                : line.kind === "del"
                                  ? styles.deletion
                                  : styles.context
                            }
                          >
                            <td className={styles.lineNumber}>
                              <span id={line.oldNo === undefined ? undefined : `${id}-old-${line.oldNo}`} tabIndex={-1}>
                                {line.oldNo}
                              </span>
                            </td>
                            <td className={styles.lineNumber}>
                              <span id={line.newNo === undefined ? undefined : `${id}-new-${line.newNo}`} tabIndex={-1}>
                                {line.newNo}
                              </span>
                            </td>
                            <td className={styles.marker}>
                              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                            </td>
                            <td>
                              <code className={wrap ? styles.wrappedCode : styles.code}>{line.text || " "}</code>
                            </td>
                          </tr>
                          {annotation(line, "old")}
                          {annotation(line, "new")}
                        </Fragment>
                      ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

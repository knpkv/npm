import { type ComponentPropsWithRef, type ReactElement, useId } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./DiffFileTree.module.css"

const style = (name: string): string => cssClass(styles, name)

/** The provider change recorded for one path in the complete diff inventory. */
export type RlyDiffFileChange = "added" | "modified" | "deleted" | "renamed"

/** Content readiness is independent from the file change, so exceptional files never disappear. */
export type RlyDiffFileContent =
  | { readonly state: "ready" }
  | { readonly label: string; readonly state: "loading" }
  | {
      readonly reason: string
      readonly state: "binary" | "generated" | "oversized" | "unavailable" | "error"
    }

interface RlyDiffFileBase {
  readonly content: RlyDiffFileContent
  readonly id: string
  readonly path: string
}

/** One indexed path. Renames always preserve both the previous and current path. */
export type RlyDiffFile =
  | (RlyDiffFileBase & { readonly change: "renamed"; readonly previousPath: string })
  | (RlyDiffFileBase & {
      readonly change: "added" | "modified" | "deleted"
      readonly previousPath?: never
    })

interface RlyIndexedInventory {
  readonly files: ReadonlyArray<RlyDiffFile>
  readonly indexedCount: number
  readonly totalCount: number
}

/** Complete or in-progress inventory state. Error states retain every path indexed so far. */
export type RlyDiffInventory =
  | { readonly files: ReadonlyArray<RlyDiffFile>; readonly state: "ready" }
  | (RlyIndexedInventory & { readonly label: string; readonly state: "loading" })
  | (RlyIndexedInventory & {
      readonly description: string
      readonly state: "error"
      readonly title: string
    })

/** Props for a complete, application-controlled changed-file inventory. */
export type DiffFileTreeProps = Omit<ComponentPropsWithRef<"nav">, "aria-label" | "children"> & {
  readonly data: RlyDiffInventory
  readonly heading: string
  readonly onSelectedFileChange: (fileId: string) => void
  readonly selectedFileId?: string
}

const contentLabel = (content: RlyDiffFileContent): string => {
  if (content.state === "ready") return "Ready"
  if (content.state === "loading") return requireText(content.label, "DiffFileTree loading label")
  return `${content.state}: ${requireText(content.reason, `DiffFileTree ${content.state} reason`)}`
}

const validateInventory = (data: RlyDiffInventory): void => {
  const ids = new Set<string>()
  for (const file of data.files) {
    const id = requireText(file.id, "DiffFileTree file id")
    if (ids.has(id)) throw new Error(`DiffFileTree file ids must be unique: ${id}`)
    ids.add(id)
    const path = requireText(file.path, `DiffFileTree path for ${id}`)
    if (file.change === "renamed") {
      const previousPath = requireText(file.previousPath, `DiffFileTree previousPath for ${id}`)
      if (previousPath === path) throw new Error(`DiffFileTree renamed paths must differ: ${id}`)
    }
    contentLabel(file.content)
  }

  if (data.state === "loading" || data.state === "error") {
    if (!Number.isInteger(data.indexedCount) || !Number.isInteger(data.totalCount)) {
      throw new Error("DiffFileTree counts must be integers")
    }
    if (data.indexedCount !== data.files.length || data.totalCount < data.indexedCount) {
      throw new Error("DiffFileTree indexedCount must match visible files and cannot exceed totalCount")
    }
    if (data.state === "loading") requireText(data.label, "DiffFileTree loading label")
    if (data.state === "error") {
      requireText(data.title, "DiffFileTree error title")
      requireText(data.description, "DiffFileTree error description")
    }
  }
}

/** Render every indexed path as a lightweight row without instantiating file content renderers. */
export const DiffFileTree = ({
  className,
  data,
  heading,
  onSelectedFileChange,
  selectedFileId,
  ...props
}: DiffFileTreeProps): ReactElement => {
  const visibleHeading = requireText(heading, "DiffFileTree heading")
  validateInventory(data)
  if (selectedFileId !== undefined && !data.files.some((file) => file.id === selectedFileId)) {
    throw new Error(`DiffFileTree selectedFileId is not in the visible inventory: ${selectedFileId}`)
  }
  const headingId = `rly-diff-file-tree-${useId()}`
  const indexedCount = data.state === "ready" ? data.files.length : data.indexedCount
  const totalCount = data.state === "ready" ? data.files.length : data.totalCount

  return (
    <nav
      {...props}
      aria-busy={data.state === "loading" ? "true" : undefined}
      aria-labelledby={headingId}
      className={classNames(style("root"), className)}
      data-rly-diff-inventory-state={data.state}
    >
      <header className={style("header")}>
        <span>
          <span className={style("eyebrow")}>Changed files</span>
          <h2 id={headingId}>{visibleHeading}</h2>
        </span>
        <strong aria-label={`${indexedCount} of ${totalCount} files indexed`} className={style("count")}>
          {indexedCount}/{totalCount}
        </strong>
      </header>

      {data.state === "loading" ? (
        <p className={style("notice")} role="status">
          {data.label}
        </p>
      ) : null}
      {data.state === "error" ? (
        <section className={style("error")} role="alert">
          <strong>{data.title}</strong>
          <span>{data.description}</span>
        </section>
      ) : null}

      {data.files.length === 0 ? (
        <p className={style("empty")}>No changed files.</p>
      ) : (
        <ol className={style("list")}>
          {data.files.map((file, index) => {
            const isSelected = selectedFileId === file.id
            return (
              <li data-rly-diff-file-id={file.id} key={file.id}>
                <button
                  aria-current={isSelected ? "true" : undefined}
                  aria-label={`File ${index + 1} of ${totalCount}: ${file.path}, ${file.change}, ${contentLabel(file.content)}`}
                  className={style("file")}
                  data-rly-diff-content-state={file.content.state}
                  data-rly-diff-file-change={file.change}
                  onClick={() => onSelectedFileChange(file.id)}
                  type="button"
                >
                  <span aria-hidden="true" className={style("index")}>
                    {index + 1}
                  </span>
                  <span className={style("pathBlock")}>
                    {file.change === "renamed" ? (
                      <span className={style("previousPath")}>{file.previousPath}</span>
                    ) : null}
                    <code className={style("path")}>{file.path}</code>
                  </span>
                  <span className={style("badges")}>
                    <span className={style("change")}>{file.change}</span>
                    <span className={style("content")}>{contentLabel(file.content)}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </nav>
  )
}

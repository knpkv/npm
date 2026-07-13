import type { ReactNode } from "react"

export interface RlyDiffTextFile {
  readonly cacheKey?: string
  readonly contents: string
  readonly name: string
}

export interface RlyDiffCodeItem {
  readonly after: RlyDiffTextFile
  readonly before: RlyDiffTextFile
  readonly collapsed?: boolean
  readonly id: string
  readonly version?: number
}

export interface RlyDiffCodeAnnotation {
  readonly id: string
  readonly itemId: string
  readonly lineNumber: number
  readonly message: string
  readonly side: "additions" | "deletions"
}

export interface RlyDiffCodeSelection {
  readonly id: string
  readonly range: {
    readonly end: number
    readonly endSide?: "additions" | "deletions"
    readonly side?: "additions" | "deletions"
    readonly start: number
  }
}

export type RlyDiffCodeScrollTarget =
  | {
    readonly align?: "center" | "end" | "nearest" | "start"
    readonly behavior?: "instant" | "smooth" | "smooth-auto"
    readonly id: string
    readonly offset?: number
    readonly type: "item"
  }
  | {
    readonly align?: "center" | "end" | "nearest" | "start"
    readonly behavior?: "instant" | "smooth" | "smooth-auto"
    readonly id: string
    readonly lineNumber: number
    readonly offset?: number
    readonly side?: "additions" | "deletions"
    readonly type: "line"
  }

export interface RlyDiffCodeViewHandle {
  addItems(items: ReadonlyArray<RlyDiffCodeItem>): void
  scrollTo(target: RlyDiffCodeScrollTarget): void
  updateItem(item: RlyDiffCodeItem): boolean
}

export interface RlyDiffCodeViewProps {
  readonly annotations?: ReadonlyArray<RlyDiffCodeAnnotation>
  readonly className?: string
  readonly contextLines?: number
  readonly empty?: ReactNode
  readonly expandContext?: boolean
  readonly initialItems: ReadonlyArray<RlyDiffCodeItem>
  readonly mode?: "split" | "stacked"
  readonly onSelectedLinesChange?: (selection: RlyDiffCodeSelection | null) => void
  readonly selectedLines?: RlyDiffCodeSelection | null
  readonly virtualization?: "buffered" | "strict"
  readonly wrap?: boolean
}

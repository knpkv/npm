/**
 * A plan id on a surface with no commit-summary loader. The word is the visible text. The short id
 * is the copy button's accessible name and the clipboard value.
 *
 *   <PlanIdCopy id={source.head} kind="head" />
 *
 * @module
 */
import { IconButton } from "@knpkv/rly/primitives"
import { useState, type ReactElement } from "react"

const wordOf = (kind: "head" | "base" | "digest"): string => {
  switch (kind) {
    case "head":
      return "Head"
    case "base":
      return "Base"
    case "digest":
      return "Digest"
  }
}

/** Head, base, or the plan digest. Not a commit title. */
export const PlanIdCopy = ({
  id,
  kind
}: {
  readonly id: string
  readonly kind: "head" | "base" | "digest"
}): ReactElement => {
  const [copyFailed, setCopyFailed] = useState(false)
  const copy = () => {
    setCopyFailed(false)
    // Older or locked-down browsers have no clipboard; say so rather than doing nothing.
    const written = navigator.clipboard?.writeText(id)
    if (written === undefined) setCopyFailed(true)
    else written.catch(() => setCopyFailed(true))
  }
  return (
    <span className="ac-id">
      <span className="ac-id-word">{wordOf(kind)}</span>
      <IconButton
        className="ac-id-copy"
        icon="copy"
        label={`Copy ${kind} ${id}`}
        onClick={copy}
        size="compact"
        variant="quiet"
      />
      {copyFailed ? (
        <span className="ac-id-status" role="alert">
          Couldn’t copy the {kind}
        </span>
      ) : null}
    </span>
  )
}

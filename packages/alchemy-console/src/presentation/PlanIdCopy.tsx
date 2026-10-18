/**
 * A plan id on a surface with no commit-summary loader. The word is the visible text. The short id
 * is the copy button's accessible name and the clipboard value.
 *
 *   <PlanIdCopy id={source.head} kind="head" />
 *
 * @module
 */
import { IconButton } from "@knpkv/rly/primitives"
import { useEffect, useRef, useState, type ReactElement } from "react"

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
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
    },
    []
  )
  const stopCopied = () => {
    if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
    copiedTimer.current = undefined
  }
  const showCopied = () => {
    stopCopied()
    setCopyFailed(false)
    setCopied(true)
    // Polite text has to leave, or the next success is the same string and is not announced.
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = undefined
      setCopied(false)
    }, 2000)
  }
  const showFailed = () => {
    stopCopied()
    setCopied(false)
    setCopyFailed(true)
  }
  const copy = () => {
    // Older or locked-down browsers have no clipboard; say so rather than doing nothing.
    const written = navigator.clipboard?.writeText(id)
    if (written === undefined) showFailed()
    else written.then(showCopied, showFailed)
  }
  return (
    <span className="ac-id">
      <span className="ac-id-word">{wordOf(kind)}</span>
      <IconButton
        className="ac-id-copy"
        icon={copied ? "check" : "copy"}
        label={`Copy ${kind} ${id}`}
        onClick={copy}
        size="inline"
        variant="quiet"
      />
      <span aria-live="polite" className="ac-id-status">
        {copied ? "Copied" : ""}
      </span>
      {copyFailed ? (
        <span className="ac-id-status" role="alert">
          Couldn’t copy the {kind}
        </span>
      ) : null}
    </span>
  )
}

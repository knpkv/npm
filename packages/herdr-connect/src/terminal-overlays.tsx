import { useEffect, useRef, useState } from "react"
import { terminalBackground, terminalForeground } from "./terminal-theme.js"

/**
 * Shown while this client knows it scrolled back: says the screen is older output and returns to
 * the newest. The rail's Latest key covers the case the client cannot see, such as a pane another
 * viewer left scrolled back.
 */
export const JumpToLatest = ({ linesBack, onJump }: { readonly linesBack: number; readonly onJump: () => void }) =>
  linesBack > 0 ? (
    <div
      aria-label={`Older output, ${linesBack} ${linesBack === 1 ? "line" : "lines"} back`}
      className="terminal-older-output"
      role="status"
    >
      <span aria-hidden="true">
        <span className="terminal-older-output-label">Older output · </span>
        {`${linesBack} ${linesBack === 1 ? "line" : "lines"} back`}
      </span>
      <button
        aria-label="Jump to latest output"
        className="terminal-key terminal-jump-latest"
        onClick={onJump}
        onPointerDown={(event) => event.preventDefault()}
        type="button"
      >
        Jump to latest
      </button>
    </div>
  ) : null

/** Words shorter than this never wrap inside themselves; longer runs such as URLs still may. */
const unbreakableWordLength = 40

/**
 * One line with its words kept whole: a hyphen is a line-break opportunity, which would split
 * "--flag" as "-" and "-flag". The characters are unchanged, so a selection copies the same text.
 */
const TerminalLineText = ({ line }: { readonly line: string }) =>
  line.split(/(\s+)/).map((part, index) =>
    part.length > 0 && part.length <= unbreakableWordLength && part.trim() === part ? (
      <span className="terminal-text-word" key={index}>
        {part}
      </span>
    ) : (
      part
    )
  )

const trimmedLines = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

/**
 * The screen as real text over the canvas, so touch devices get native selection handles and the
 * Copy menu. Each entry is one terminal line with its wrapped rows joined; CSS re-wraps it at the
 * terminal width, so a selection copies the line whole.
 */
export const TerminalTextLayer = ({
  lines,
  onCopy,
  onDone
}: {
  readonly lines: ReadonlyArray<string>
  readonly onCopy: (text: string) => void
  readonly onDone: () => void
}) => {
  const layerRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState("")
  useEffect(() => {
    const change = (): void => {
      const selection = window.getSelection()
      const layer = layerRef.current
      const inside =
        selection !== null && layer !== null && selection.anchorNode !== null && layer.contains(selection.anchorNode)
      setSelected(inside ? selection.toString() : "")
    }
    document.addEventListener("selectionchange", change)
    return () => document.removeEventListener("selectionchange", change)
  }, [])
  const screen = lines.join("\n").replace(/\n+$/, "")
  return (
    <div
      aria-label="Terminal text"
      className="terminal-text-layer"
      style={{ background: terminalBackground, color: terminalForeground }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDone()
      }}
      role="region"
    >
      <div className="terminal-text-actions">
        <button
          className="terminal-key"
          disabled={selected === ""}
          onClick={() => onCopy(trimmedLines(selected))}
          type="button"
        >
          Copy selection
        </button>
        <button className="terminal-key" onClick={() => onCopy(screen)} type="button">
          Copy screen
        </button>
        <button className="terminal-key" onClick={onDone} type="button">
          Done
        </button>
      </div>
      <div className="terminal-text-lines" ref={layerRef}>
        {lines.map((line, index) => (
          <div key={index}>{line === "" ? "\u00a0" : <TerminalLineText line={line} />}</div>
        ))}
      </div>
    </div>
  )
}

/**
 * 5×5 ASCII digit timer display for the TUI main view.
 *
 * @internal
 */
import { useElapsedTimer } from "../hooks/useElapsedTimer.js"
import { useTerminalSize } from "../hooks/useTerminalSize.js"

// 5-line tall digit font (each digit is 5 rows × 5 cols)
const DIGITS: Record<string, ReadonlyArray<string>> = {
  "0": ["╔═══╗", "║   ║", "║   ║", "║   ║", "╚═══╝"],
  "1": ["    ╗", "    ║", "    ║", "    ║", "    ╝"],
  "2": ["╔═══╗", "    ║", "╔═══╝", "║    ", "╚═══╝"],
  "3": ["╔═══╗", "    ║", " ═══╣", "    ║", "╚═══╝"],
  "4": ["╗   ╗", "║   ║", "╚═══╣", "    ║", "    ╝"],
  "5": ["╔═══╗", "║    ", "╚═══╗", "    ║", "╚═══╝"],
  "6": ["╔═══╗", "║    ", "╠═══╗", "║   ║", "╚═══╝"],
  "7": ["╔═══╗", "    ║", "    ║", "    ║", "    ╝"],
  "8": ["╔═══╗", "║   ║", "╠═══╣", "║   ║", "╚═══╝"],
  "9": ["╔═══╗", "║   ║", "╚═══╣", "    ║", "╚═══╝"],
  ":": ["     ", "  ●  ", "     ", "  ●  ", "     "]
}

function renderBigTime(h: number, m: number, s: number): ReadonlyArray<string> {
  const chars = [...String(h).padStart(2, "0"), ":", ...String(m).padStart(2, "0"), ":", ...String(s).padStart(2, "0")]

  const rows: Array<string> = ["", "", "", "", ""]
  for (const char of chars) {
    const glyph = DIGITS[char] ?? DIGITS["0"]!
    for (let row = 0; row < 5; row++) {
      rows[row] += glyph![row]! + " "
    }
  }
  return rows
}

function centerPad(text: string, width: number): string {
  if (text.length >= width) return text
  const left = Math.floor((width - text.length) / 2)
  return " ".repeat(left) + text
}

export function BigTimer() {
  const { elapsed, timerState } = useElapsedTimer()

  const h = Math.floor(elapsed / 3600)
  const m = Math.floor((elapsed % 3600) / 60)
  const s = elapsed % 60
  const rows = renderBigTime(h, m, s)

  const cols = useTerminalSize()

  // Progress bar
  const barWidth = 40
  const filled = Math.floor((s / 60) * barWidth)
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled)

  // Metadata line
  const meta = [
    timerState?.projectName ? `● ${timerState.projectName}` : timerState?.projectId ? "● project" : null,
    timerState?.billable ? "● billable" : timerState?.billable === false ? "○ non-billable" : null
  ]
    .filter(Boolean)
    .join("   ")

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, width: "100%" }}>
      {/* Spacer */}
      <box style={{ flexGrow: 1 }} />

      {/* Ticket info — centered */}
      <box style={{ height: 1 }}>
        <text fg="#00CCFF">{centerPad(timerState?.ticketKey ?? "", cols)}</text>
      </box>
      <box style={{ height: 1 }}>
        <text fg="#888888">{centerPad(timerState?.summary?.slice(0, 60) ?? "", cols)}</text>
      </box>

      {/* Spacer */}
      <box style={{ height: 1 }} />

      {/* Big digits — centered */}
      {rows.map((row, i) => (
        <box key={i} style={{ height: 1 }}>
          <text fg="#7aa87a">{centerPad(row, cols)}</text>
        </box>
      ))}

      {/* Spacer */}
      <box style={{ height: 1 }} />

      {/* Progress bar — centered */}
      <box style={{ height: 1 }}>
        <text fg="#3a5a3a">{centerPad(bar, cols)}</text>
      </box>

      {/* Spacer */}
      <box style={{ height: 1 }} />

      {/* Controls — centered */}
      <box style={{ height: 1 }}>
        <text fg="#888888">{centerPad("x stop    d discard    l tickets    q quit", cols)}</text>
      </box>

      {/* Meta — centered */}
      {meta ? (
        <box style={{ height: 1 }}>
          <text fg="#555555">{centerPad(meta, cols)}</text>
        </box>
      ) : null}

      {/* Spacer */}
      <box style={{ flexGrow: 1 }} />
    </box>
  )
}

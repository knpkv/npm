import { Effect } from "effect"
import type { BoardView } from "../model.js"
import {
  breakSegments,
  cardFacts,
  type Connection,
  connectionLine,
  headline,
  identifierFacts,
  stateWord,
  totals
} from "./board-copy.js"
import { readBoard } from "./read-board.js"
import "@knpkv/rly/styles.css"
import "./styles.css"

const form = document.querySelector("form")
const boardInput = document.querySelector<HTMLInputElement>("#board")
const credential = document.querySelector<HTMLInputElement>("#credential")
const keyError = document.querySelector<HTMLElement>("#key-error")
const connection = document.querySelector("#connection")
const view = document.querySelector<HTMLElement>("#board-view")
const agents = document.querySelector("#agents")
const title = document.querySelector("#title")
const headlineNode = document.querySelector("#headline")
const totalsNode = document.querySelector("#totals")
const lock = document.querySelector<HTMLButtonElement>("#lock")

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const node = document.createElement(tag)
  node.textContent = text
  if (className !== undefined) node.className = className
  return node
}

/** A `dd` holding an identifier, with a break opportunity at each of its separators. */
function identifier(value: string) {
  const node = element("dd", "", "identifier")
  breakSegments(value).forEach((segment, index) => {
    if (index > 0) node.append(document.createElement("wbr"))
    node.append(segment)
  })
  return node
}

if (
  form !== null && boardInput !== null && credential !== null && keyError !== null && connection !== null &&
  view !== null && agents !== null && title !== null && headlineNode !== null && totalsNode !== null && lock !== null
) {
  let key = ""
  let boardId = ""
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // Receipt time of the snapshot on screen; an outage keeps it visible, labelled with this age.
  let shownFrom: number | null = null

  /** The state word in its own element (held or blocked ink), then plain text. */
  const announce = (state: Connection) => {
    const line = connectionLine(state)
    connection.setAttribute("data-state", state._tag.toLowerCase())
    connection.replaceChildren(element("strong", line.word), line.rest === "" ? "" : `: ${line.rest}`)
  }
  const showKeyError = (message: string | null) => {
    keyError.textContent = message ?? ""
    keyError.hidden = message === null
    if (message === null) {
      credential.removeAttribute("aria-invalid")
      credential.setAttribute("aria-describedby", "key-help")
    } else {
      credential.setAttribute("aria-invalid", "true")
      credential.setAttribute("aria-describedby", "key-error key-help")
    }
  }
  const render = (data: BoardView) => {
    title.textContent = data.snapshot.title
    headlineNode.textContent = headline(data.snapshot.agents)
    totalsNode.textContent = totals(data.snapshot.agents)
    agents.replaceChildren(...data.snapshot.agents.map((agent) => {
      const row = element("li", "", `agent ${agent.state}`)
      row.append(
        element("p", stateWord[agent.state], "state"),
        element("h3", agent.name),
        element("p", agent.task ?? "No task published", "task"),
        element("p", agent.status)
      )
      // The state word above already says Blocked; this line gives only the reason.
      if (agent.blocker !== null) row.append(element("p", agent.blocker, "blocker"))
      const facts = cardFacts(agent)
      if (facts.known.length > 0) {
        const details = element("dl", "")
        for (const [label, value] of facts.known) {
          details.append(element("dt", label), identifierFacts.has(label) ? identifier(value) : element("dd", value))
        }
        row.append(details)
      }
      if (facts.unpublished.length > 0) {
        row.append(element("p", `Not published: ${facts.unpublished.join(", ")}`, "unpublished"))
      }
      return row
    }))
    view.hidden = false
  }
  const clear = () => {
    generation++
    key = ""
    shownFrom = null
    credential.value = ""
    clearTimeout(timer)
    agents.replaceChildren()
    title.textContent = "Board"
    headlineNode.textContent = ""
    totalsNode.textContent = ""
    lock.hidden = true
    view.hidden = true
    form.hidden = false
    announce({ _tag: "Locked" })
  }
  const poll = async () => {
    const current = generation
    try {
      const response = await Effect.runPromise(readBoard(boardId, key))
      if (generation !== current) return
      if (response.status === 401) {
        // A rejected key forgets everything it showed: the board locks again.
        clear()
        showKeyError("View key not accepted. Check the board name and paste the key again.")
        credential.focus()
        return
      }
      if (response.status === 204) {
        agents.replaceChildren()
        view.hidden = true
        shownFrom = null
        announce({ _tag: "Waiting" })
      } else if (response.data !== null) {
        render(response.data)
        shownFrom = response.data.receivedAt
        announce({ _tag: response.data.stale ? "Stale" : "Current", receivedAt: response.data.receivedAt })
      } else {
        announce({ _tag: "Offline", shownFrom })
      }
    } catch {
      if (generation !== current) return
      announce({ _tag: "Offline", shownFrom })
    }
    if (generation === current && key !== "") timer = setTimeout(poll, 10000)
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    clearTimeout(timer)
    generation++
    key = credential.value
    credential.value = ""
    boardId = boardInput.value
    showKeyError(null)
    form.hidden = true
    lock.hidden = false
    announce({ _tag: "Opening" })
    void poll()
    lock.focus()
  })
  lock.addEventListener("click", () => {
    clear()
    credential.focus()
  })
  window.addEventListener("pagehide", clear)
}

import { Effect } from "effect"
import { readBoard } from "./read-board.js"
import "@knpkv/rly/styles.css"
import "./styles.css"

const form = document.querySelector("form")
const boardInput = document.querySelector<HTMLInputElement>("#board")
const credential = document.querySelector<HTMLInputElement>("#credential")
const connection = document.querySelector("#connection")
const view = document.querySelector<HTMLElement>("#board-view")
const agents = document.querySelector("#agents")
const title = document.querySelector("#title")
const freshness = document.querySelector("#freshness")
const totals = document.querySelector("#totals")
const lock = document.querySelector<HTMLButtonElement>("#lock")

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const node = document.createElement(tag)
  node.textContent = text
  if (className !== undefined) node.className = className
  return node
}
const duration = (seconds: number | undefined) =>
  seconds === undefined ? "Unavailable" : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`

if (
  form !== null && boardInput !== null && credential !== null && connection !== null && view !== null &&
  agents !== null && title !== null && freshness !== null && totals !== null && lock !== null
) {
  let key = ""
  let boardId = ""
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    generation++
    key = ""
    credential.value = ""
    clearTimeout(timer)
    agents.replaceChildren()
    title.textContent = "Board"
    freshness.textContent = ""
    totals.textContent = ""
    lock.hidden = true
    view.hidden = true
    form.hidden = false
    connection.textContent = "Locked"
  }
  const poll = async () => {
    const current = generation
    try {
      const response = await Effect.runPromise(readBoard(boardId, key))
      if (generation !== current) return
      if (response.status === 401) {
        clear()
        connection.textContent = "View key not accepted. Check the board and key."
        credential.focus()
        return
      }
      if (response.status === 204) {
        agents.replaceChildren()
        view.hidden = true
        connection.textContent = "No published data. Waiting for the publisher."
      } else if (response.data !== null) {
        const data = response.data
        title.textContent = data.snapshot.title
        connection.textContent = data.stale
          ? "Stale · Publisher has not updated this board recently"
          : "Current · Published snapshot"
        freshness.textContent = `Received ${new Date(data.receivedAt).toLocaleTimeString()} · Source ${
          new Date(data.snapshot.sourceAt).toLocaleTimeString()
        }`
        totals.textContent = `${data.snapshot.agents.length} agents · ${
          data.snapshot.agents.filter((agent) => agent.state === "working").length
        } working · ${data.snapshot.agents.filter((agent) => agent.state === "blocked").length} blocked`
        agents.replaceChildren(...data.snapshot.agents.map((agent) => {
          const row = element("li", "", `agent ${agent.state}`)
          row.append(
            element("p", agent.state, "state"),
            element("h3", agent.name),
            element("p", agent.task ?? "Task unavailable", "task"),
            element("p", agent.status)
          )
          if (agent.blocker !== null) row.append(element("p", `Blocked: ${agent.blocker}`, "blocker"))
          const details = element("dl", "")
          for (
            const [label, value] of [
              ["Jira", agent.jiraKey ?? "Unavailable"],
              ["Branch", agent.branch ?? "Unavailable"],
              ["PR", agent.pullRequest ?? "Unavailable"],
              ["Clockify recorded", duration(agent.clockify?.seconds)],
              ["Agent elapsed", duration(agent.elapsedSeconds ?? undefined)]
            ]
          ) {
            if (label !== undefined && value !== undefined) details.append(element("dt", label), element("dd", value))
          }
          row.append(details)
          return row
        }))
        view.hidden = false
      } else {
        view.hidden = true
        agents.replaceChildren()
        connection.textContent = "Offline · Board unavailable. Retrying."
      }
    } catch {
      if (generation !== current) return
      view.hidden = true
      agents.replaceChildren()
      connection.textContent = "Offline · Connection lost. Retrying."
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
    form.hidden = true
    lock.hidden = false
    connection.textContent = "Opening board"
    void poll()
    lock.focus()
  })
  lock.addEventListener("click", () => {
    clear()
    credential.focus()
  })
  window.addEventListener("pagehide", clear)
}

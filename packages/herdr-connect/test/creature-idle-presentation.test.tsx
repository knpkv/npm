import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { Creature } from "../src/creature.js"

describe("idle evidence during lifecycle transitions", () => {
  it("keeps needs-input and terminal poses ahead of the previous debounced idle kind", () => {
    for (const state of ["waiting", "blocked", "done"]) {
      const markup = renderToStaticMarkup(
        <Creature host="build-01" id="agent-builder-alpha" size="stage" state={state} taskKind="idle" />
      )
      expect(markup, state).not.toContain("data-idle-motion")
    }
  })

  it("activates only explicit idle evidence on an ordinary live creature", () => {
    const render = (taskKind?: "idle" | "unknown") => {
      return renderToStaticMarkup(
        <Creature host="build-01" id="agent-builder-alpha" size="row" state="idle" taskKind={taskKind} />
      )
    }
    expect(render("idle")).toContain("data-idle-motion")
    expect(render()).not.toContain("data-idle-motion")
    expect(render("unknown")).not.toContain("data-idle-motion")
  })
})

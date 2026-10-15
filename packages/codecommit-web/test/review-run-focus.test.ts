// @vitest-environment happy-dom
import { afterEach, expect, it } from "@effect/vitest"
import { preserveReviewRunFocus } from "../src/client/review-run-focus.js"

afterEach(() => document.body.replaceChildren())

it("keeps focus in the retained pane before rerun disables its control and replaces results", () => {
  const pane = document.createElement("aside")
  pane.tabIndex = -1
  const run = document.createElement("button")
  run.textContent = "Run again"
  const findings = document.createElement("section")
  findings.textContent = "Completed findings"
  pane.append(run, findings)
  document.body.append(pane)
  run.focus()
  expect(document.activeElement).toBe(run)

  preserveReviewRunFocus(pane)
  expect(document.activeElement).toBe(pane)
  run.disabled = true
  const progress = document.createElement("p")
  progress.textContent = "Relay is reviewing"
  findings.replaceWith(progress)
  expect(document.activeElement).toBe(pane)

  progress.replaceWith(findings)
  run.disabled = false
  expect(document.activeElement).toBe(pane)
})

it("keeps focus in the pane when loading removes a focused finding action", () => {
  const pane = document.createElement("aside")
  pane.tabIndex = -1
  const action = document.createElement("button")
  pane.append(action)
  document.body.append(pane)
  action.focus()
  preserveReviewRunFocus(pane)
  action.remove()
  expect(document.activeElement).toBe(pane)
})

it("does not take focus from Relay or another owner when a review starts elsewhere", () => {
  const pane = document.createElement("aside")
  pane.tabIndex = -1
  const composer = document.createElement("textarea")
  document.body.append(pane, composer)
  composer.focus()
  preserveReviewRunFocus(pane)
  expect(document.activeElement).toBe(composer)
  preserveReviewRunFocus(null)
  expect(document.activeElement).toBe(composer)
})

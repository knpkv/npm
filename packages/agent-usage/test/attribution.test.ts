import { describe, expect, it } from "@effect/vitest"
import {
  bookingId,
  bookingOf,
  claudeHumanText,
  codexHumanText,
  repoName,
  singleTicket,
  ticketKeyFromBranch,
  ticketKeyFromPath
} from "../src/core/Attribution.js"

describe("ticket keys", () => {
  it("reads a key bounded by underscores, which \\b would miss", () => {
    expect(ticketKeyFromBranch("feature_PROJ-42_work")).toBe("PROJ-42")
  })

  it("does not read lower-case or single-letter prefixes as keys", () => {
    expect(ticketKeyFromBranch("feat/jcf-ai")).toBeNull()
    expect(ticketKeyFromBranch("v2-3")).toBeNull()
  })

  it("takes the deepest key in a path", () => {
    expect(ticketKeyFromPath("/dev/repo/worktrees/PROJ-1/PROJ-2")).toBe("PROJ-2")
  })

  it("mines one ticket from prose, ignoring placeholders", () => {
    expect(singleTicket("work on RPS-7071 please")).toBe("RPS-7071")
    expect(singleTicket("approved RPS-1234 like the docs say")).toBeNull()
    expect(singleTicket("compare RPS-7071 and RPS-7072")).toBeNull()
  })
})

describe("bookingOf", () => {
  it("prefers the branch, then the path, then the active ticket", () => {
    expect(bookingOf({ branch: "feat/RPS-1", cwd: "/w/RPS-2", activeTicket: "RPS-3" })).toEqual({
      _tag: "Ticket",
      key: "RPS-1"
    })
    expect(bookingOf({ branch: "main", cwd: "/w/RPS-2", activeTicket: "RPS-3" })).toEqual({
      _tag: "Ticket",
      key: "RPS-2"
    })
    expect(bookingOf({ branch: "main", cwd: "/w/app", activeTicket: "RPS-3" })).toEqual({
      _tag: "Ticket",
      key: "RPS-3"
    })
  })

  it("books to the repo when nothing names a ticket", () => {
    expect(bookingOf({ branch: "main", cwd: "/home/a/code/app", activeTicket: null })).toEqual({
      _tag: "Repo",
      name: "app"
    })
  })

  it("names the repo of a worktree by its worktrees segment", () => {
    expect(repoName("/home/a/worktrees/npm/feat/x")).toBe("npm")
  })

  it("keeps tickets and repos apart in their ids", () => {
    expect(bookingId({ _tag: "Ticket", key: "RPS-1" })).toBe("ticket:RPS-1")
    expect(bookingId({ _tag: "Repo", name: "npm" })).toBe("repo:npm")
  })
})

describe("human-typed text", () => {
  it("drops Claude system reminders that quote instruction files", () => {
    const content =
      "<system-reminder>Contents of AGENTS.md: approved RPS-1234 ✅ see RPS-9999</system-reminder>\nfix RPS-7071"
    expect(claudeHumanText(content)).toBe("fix RPS-7071")
  })

  it("drops Claude tool results and keeps text blocks", () => {
    expect(
      claudeHumanText([
        { type: "tool_result" },
        { type: "text", text: "look at RPS-7071" }
      ])
    ).toBe("look at RPS-7071")
  })

  it("drops Codex AGENTS.md and environment context items", () => {
    expect(codexHumanText("# AGENTS.md instructions\n\n<INSTRUCTIONS>approved RPS-4242</INSTRUCTIONS>")).toBe("")
    expect(codexHumanText("<environment_context>\n  <cwd>/w/RPS-4242</cwd>\n</environment_context>")).toBe("")
    expect(codexHumanText("please do RPS-7071")).toBe("please do RPS-7071")
  })
})

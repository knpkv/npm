// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readReleaseAgentThread } from "../../src/client/releases/releaseAgentThreadStorage.js"
import { ReleaseId } from "../../src/domain/identifiers.js"

const SESSION_ID = "01890f6f-6d6a-7cc0-98d2-000000000002"
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000011")
const STORAGE_KEY = `cc_release_agent_thread:${SESSION_ID}:${RELEASE_ID}`

const message = (id: string, role: "assistant" | "user") => ({
  content: `${role} content`,
  dateTime: "2026-07-16T10:00:00.000Z",
  id,
  role,
  time: "10:00"
})

beforeEach(() => {
  sessionStorage.setItem("cc_session_id", SESSION_ID)
})

afterEach(() => {
  sessionStorage.clear()
})

describe("release-agent thread storage", () => {
  it("rejects a decoded thread with duplicate message ids", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        message("turn-0-human", "user"),
        message("turn-0-human", "assistant")
      ])
    )

    expect(readReleaseAgentThread(RELEASE_ID)).toEqual([])
  })

  it("loads a decoded thread whose message ids are distinct", () => {
    const stored = [
      message("turn-0-human", "user"),
      message("turn-0-agent", "assistant")
    ]
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

    expect(readReleaseAgentThread(RELEASE_ID)).toEqual(stored)
  })
})

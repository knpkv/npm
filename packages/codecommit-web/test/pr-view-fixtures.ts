import { afterEach, expect } from "@effect/vitest"
import * as Domain from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { act, createElement, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"

export const now = new Date("2026-10-05T15:30:00Z")
const decodePullRequest = Schema.decodeSync(Domain.PullRequest)
export const makePullRequest = (overrides: Partial<Parameters<typeof decodePullRequest>[0]> = {}) =>
  decodePullRequest({
    account: { profile: "primary", region: "eu-west-1", awsAccountId: "111122223333", repoAccountId: "111122223333" },
    approvalRules: [],
    approvedBy: [],
    author: "contributor",
    commentedBy: [],
    creationDate: new Date("2026-10-03T12:00:00Z"),
    destinationBranch: "main",
    id: "7",
    isApproved: true,
    isMergeable: true,
    lastModifiedDate: new Date("2026-10-05T12:30:00Z"),
    fetchedAt: new Date("2026-10-05T15:00:00Z"),
    link: "https://example.invalid/pr/7",
    repositoryName: "infra-core",
    sourceBranch: "feature",
    status: "OPEN",
    title: "feat(queue): simplify retries",
    ...overrides
  })

const decodeLocation = Schema.decodeSync(Domain.PRCommentLocationJson)
export const makeLocation = (overrides: Partial<Parameters<typeof decodeLocation>[0]> = {}) =>
  decodeLocation({
    filePath: "src/retry.ts",
    beforeCommitId: "base",
    afterCommitId: "head",
    relativeFileVersion: "AFTER",
    comments: [{
      root: {
        id: "c1",
        content: "**Review feedback**",
        author: "reviewer",
        creationDate: "2026-10-03T14:00:00Z",
        deleted: false,
        lineNumber: 12
      },
      replies: []
    }],
    ...overrides
  })

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })
const mounted = new Map<ReturnType<typeof createRoot>, HTMLDivElement>()
afterEach(async () => {
  for (const [root, host] of mounted) {
    await act(async () => root.unmount())
    host.remove()
  }
  mounted.clear()
})

export const mountFixture = async (view: ReactNode) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.set(root, host)
  const render = async (next: ReactNode) => {
    await act(async () => root.render(createElement(MemoryRouter, null, next)))
  }
  await render(view)
  return {
    host,
    render,
    unmount: async () => {
      await act(async () => root.unmount())
      mounted.delete(root)
      host.remove()
    }
  }
}

export const click = async (scope: ParentNode, label: string) => {
  const button = [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === label)
  expect(button, label).toBeDefined()
  await act(async () => button?.click())
}
export const clickNamed = async (scope: ParentNode, label: string) => {
  const button = [...scope.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label)
  expect(button, label).toBeDefined()
  await act(async () => button?.click())
}
export const editInput = async (input: HTMLInputElement | null, value: string) => {
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

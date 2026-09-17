// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import type { WeeklyStats } from "@knpkv/codecommit-core/StatsService/WeeklyStats.js"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { MostActivePRs, StalePRs } from "../src/client/components/stats-charts.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
})

const activePR = (accountRegion: string): WeeklyStats["mostActivePRs"][number] => ({
  id: "42",
  title: `Payments ${accountRegion}`,
  author: "alice",
  repositoryName: "payments",
  accountRegion,
  commentCount: 2,
  awsAccountId: "111"
})

const stalePR = (accountRegion: string): WeeklyStats["stalePRs"][number] => ({
  id: "42",
  title: `Payments ${accountRegion}`,
  author: "alice",
  repositoryName: "payments",
  accountRegion,
  daysSinceActivity: 8,
  awsAccountId: "111"
})

const clickRows = async (host: HTMLElement, title: string) => {
  const rows = Array.from(host.querySelectorAll<HTMLElement>(".cursor-pointer")).filter((element) =>
    element.textContent?.includes(title)
  )
  expect(rows).toHaveLength(2)
  for (const row of rows) await act(async () => row.click())
}

describe("stats PR navigation", () => {
  it("passes repository and region for active and stale rows", async () => {
    const onPRClick = vi.fn()
    const host = document.createElement("div")
    root = createRoot(host)
    await act(async () =>
      root?.render(
        createElement(
          "div",
          null,
          createElement(MostActivePRs, { prs: [activePR("eu-west-1"), activePR("us-east-1")], onPRClick }),
          createElement(StalePRs, { prs: [stalePR("eu-west-1"), stalePR("us-east-1")], onPRClick })
        )
      )
    )

    await clickRows(host, "Payments eu-west-1")
    await clickRows(host, "Payments us-east-1")

    expect(onPRClick).toHaveBeenCalledWith("111", "42", "payments", "eu-west-1")
    expect(onPRClick).toHaveBeenCalledWith("111", "42", "payments", "us-east-1")
    expect(onPRClick).toHaveBeenCalledTimes(4)
  })
})

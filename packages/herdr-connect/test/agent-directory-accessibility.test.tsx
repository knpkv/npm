import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ConnectAgent } from "../src/model.js"
import { AgentDirectory } from "../src/view.js"

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "SER8",
  id: Schema.decodeUnknownSync(AgentStableId)("agent-reviewer"),
  kind: "codex",
  lastActivityAt: 1_000,
  name: "Review worker",
  state: "working",
  work: "npm"
})

const filterAttributes = (markup: string, pattern: RegExp): Array<string> =>
  [...markup.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))

const directory = (key: string) => (
  <AgentDirectory
    activityFilter="all"
    agents={[agent]}
    hostFilter={null}
    key={key}
    onActivityFilter={() => undefined}
    onHostFilter={() => undefined}
    onSelect={() => undefined}
    query=""
    selectedKey={null}
  />
)

describe("AgentDirectory filter accessibility", () => {
  it("keeps filter labels unique and associated across multiple directories", () => {
    const markup = renderToStaticMarkup(
      <>
        {directory("first")}
        {directory("second")}
      </>
    )
    const ids = filterAttributes(markup, /<span class="connect-filter-label" id="([^"]+)"/gu)
    const labelledBy = filterAttributes(markup, /aria-labelledby="([^"]+)"/gu)

    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    expect(labelledBy.toSorted()).toEqual(ids.toSorted())
  })
})

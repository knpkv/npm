import { ResourceDetailView, StackDetailView, StackListView, type StackTab } from "@knpkv/alchemy-console/views"
import "@knpkv/alchemy-console/views/style.css"
import { ThemeProvider, useDocumentTheme } from "@knpkv/rly/foundations"
import { useState, type ReactElement } from "react"
import { createRoot } from "react-dom/client"
import { planFixtures, planStack } from "./plan-fixtures.js"
import { detailFixtures } from "./detail-fixtures.js"
import "./fixture.css"
import { props } from "./views.js"

/** This host supplies only presentation fixtures and routes. No console runtime, providers or private configuration. */
const Consumer = (): ReactElement => {
  useDocumentTheme("system")
  const selected = detailFixtures.find(
    (fixture) => fixture.name === new URLSearchParams(window.location.search).get("fixture")
  )
  const selectedPlan = planFixtures.find(
    (fixture) => fixture.name === new URLSearchParams(window.location.search).get("fixture")
  )
  const [tab, setTab] = useState<StackTab>(selectedPlan === undefined ? (selected?.tab ?? "resources") : "plan")
  return (
    <ThemeProvider theme="system">
      <main className="consumer-main">
        {selectedPlan !== undefined ? (
          <StackDetailView
            state={{ _tag: "Ready", stack: planStack }}
            copy={props.copy}
            tab={tab}
            onTabChange={setTab}
            onReadAgain={() => undefined}
            resourceHref={() => "?fixture=6e"}
            planState={selectedPlan.state}
            onReadPlanAgain={() => undefined}
          />
        ) : selected === undefined ? (
          <StackListView {...props} state={{ _tag: "Ready", list: { stacks: [], issues: [] }, checkedAt: "12:00" }} />
        ) : selected.resource !== null ? (
          <ResourceDetailView
            stack={selected.stack}
            resource={selected.resource}
            copy={props.copy}
            stackHref="?fixture=6a"
            resourceHref={() => "?fixture=6e"}
          />
        ) : (
          <StackDetailView
            state={{ _tag: "Ready", stack: selected.stack }}
            copy={props.copy}
            tab={tab}
            onTabChange={setTab}
            onReadAgain={() => undefined}
            resourceHref={() => "?fixture=6e"}
          />
        )}
      </main>
    </ThemeProvider>
  )
}
const root = document.getElementById("root")
if (root !== null) createRoot(root).render(<Consumer />)

// Fixtures from packages/codecommit-web/test/findings-drawer.test.ts and packages/codecommit-web/e2e/pr-review-workspace.spec.ts.
import { FindingsDrawer } from "@knpkv/codecommit-web-design-system"
import { findings } from "../fixtures/findings.js"

const noop = () => {}
const returnFocus = () => null
const drawer = (items: typeof findings) => <div style={{ transform: "translateZ(0)", height: 480 }}>
  <FindingsDrawer open title={`Findings (${items.length})`} onClose={noop} returnFocus={returnFocus}>
    <aside aria-label="Relay findings" style={{ padding: 16 }}>
      <ul style={{ margin: 0, paddingInlineStart: 20 }}>
        {items.map((finding) => <li key={finding.id} style={{ marginBlockEnd: 16 }}>
          <strong>{finding.priority} · {finding.title}</strong>
          <p>{finding.summary}</p>
        </li>)}
      </ul>
    </aside>
  </FindingsDrawer>
</div>

/** Open modal with the test's two findings. */
export const TwoFindings = () => drawer(findings)
/** A short single-finding modal. */
export const OneFinding = () => drawer(findings.slice(0, 1))

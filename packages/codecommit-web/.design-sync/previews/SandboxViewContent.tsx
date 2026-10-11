// Fixtures from packages/codecommit-web/test/sandbox-view.test.ts.
import { SandboxViewContent } from "@knpkv/codecommit-web-design-system"
import { actions, noop, sandboxState } from "../fixtures/sandboxes.js"

const credentials = () => null
/** Running workspace logs, without requesting a live editor. */
export const RunningLogs = () => <div style={{ height: 480 }}><SandboxViewContent state={sandboxState("running")} sandboxId="sandbox-1" initialView="logs" onViewChange={noop} renderCredentials={credentials} {...actions} /></div>
/** A stopped workspace shows logs and a restart action. */
export const Stopped = () => <div style={{ height: 480 }}><SandboxViewContent state={sandboxState("stopped")} sandboxId="sandbox-1" initialView="editor" onViewChange={noop} renderCredentials={credentials} {...actions} /></div>

// Fixtures from packages/codecommit-web/test/sandboxes-page.test.ts and packages/codecommit-web/test/sandbox-view.test.ts.
import { SandboxesPageView } from "@knpkv/codecommit-web-design-system"
import { actions, emptyInventory, inventory } from "../fixtures/sandboxes.js"

/** One running sandbox and one stopped sandbox. */
export const Inventory = () => <SandboxesPageView state={inventory} {...actions} />
/** The empty inventory points back to pull requests. */
export const Empty = () => <SandboxesPageView state={emptyInventory} {...actions} />

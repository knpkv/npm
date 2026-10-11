// Fixtures from packages/codecommit-web/test/queue-controls-view.test.ts.
import { FilterSidebarView } from "@knpkv/codecommit-web-design-system"
import { filters, sidebarProps } from "../fixtures/queue-controls.js"

/** Review mode is selected for a known caller. */
export const Review = () => <FilterSidebarView {...sidebarProps} state={{ ...filters, review: true }} />
/** No queue mode or structured filter is selected. */
export const All = () => <FilterSidebarView {...sidebarProps} />
/** Unknown caller identity hides the personal queue modes. */
export const IdentityUnknown = () => <FilterSidebarView {...sidebarProps} currentUser={undefined} />
/** The tested open group is applied. */
export const OpenSelected = () => <FilterSidebarView {...sidebarProps} state={{ ...filters, filters: [{ key: "status", value: "open" }] }} />

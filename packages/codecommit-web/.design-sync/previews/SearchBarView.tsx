// Fixtures from packages/codecommit-web/test/queue-controls-view.test.ts.
import { SearchBarView } from "@knpkv/codecommit-web-design-system"
import { filters, searchProps, selectedFilters } from "../fixtures/queue-controls.js"

/** Search, repository chip and relative date bounds are applied. */
export const Filtered = () => <SearchBarView {...searchProps} state={selectedFilters} />
/** No chips or reset action in an empty search. */
export const Empty = () => <SearchBarView {...searchProps} />
/** Review mode keeps reset available without adding a chip. */
export const ReviewOnly = () => <SearchBarView {...searchProps} state={{ ...filters, review: true }} />

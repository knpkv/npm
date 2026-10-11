// Fixtures from packages/codecommit-web/test/filter-selection-indicator.test.ts and packages/codecommit-web/test/workbench-rail.test.ts.
import { FilterSelectionIndicator } from "@knpkv/codecommit-web-design-system"
import { waitingQueue } from "../fixtures/pull-requests.js"

const noop = () => {}
const repositoryCount = waitingQueue.rows.filter(({ pullRequest }) => pullRequest.repositoryName === "infra-core").length
const authorCount = waitingQueue.rows.filter(({ pullRequest }) => pullRequest.author === "contributor").length

// FilterCombobox's option composition, with CommandItem's Tailwind row classes.
const option = (group: string, label: string, count: number, selected: boolean) => (
  <div className="bg-popover text-popover-foreground flex w-full flex-col overflow-hidden rounded-md border">
    <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">{group}</div>
    <div className="text-foreground overflow-hidden p-1" role="group" aria-label={`${group} filter options`}>
      <button
        aria-pressed={selected}
        className="relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
        onClick={noop}
        type="button"
      >
        <FilterSelectionIndicator selected={selected} />
        <span className="flex-1 text-start">{label}</span>
        <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
      </button>
    </div>
  </div>
)

/** Repository filter applied to the fixture's three pull requests. */
export const Selected = () => option("Repository", "infra-core", repositoryCount, true)
/** The same repository is available but unapplied. */
export const NotSelected = () => option("Repository", "infra-core", repositoryCount, false)
/** The fixture's author filter is applied. */
export const AuthorSelected = () => option("Author", "contributor", authorCount, true)
/** The author filter is available but unapplied. */
export const AuthorNotSelected = () => option("Author", "contributor", authorCount, false)

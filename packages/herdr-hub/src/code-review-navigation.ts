/** Review selections keep the shell hash route and use its history/focus owner. @module */
import type { CodeReference, CodeReviewThreadTarget } from "@knpkv/codecommit-web/host"
import type { CodeHostPage } from "@knpkv/codecommit-web/views"
import { type CodeSelection, codeSelectionSearch } from "./code-selection.js"
import { codeModule } from "./module-contract.js"
import { moduleHref } from "./module-navigation.js"
import type { ModulePageMount } from "./modules.js"

/** This adapter exists only under a decoded opaque PR selection. No provider locator or global history. */
export interface CodeReviewNavigationOptions {
  readonly page: CodeHostPage
  readonly selection: CodeSelection & { readonly ref: CodeReference }
  readonly navigate: ModulePageMount["navigate"]
}

/**
 * Finding activation selects Review on this exact Code page. The host activation effect opens
 * secondary before focusing its card; null prevents shell page-focus from overwriting that handoff.
 * A different selection delegates one push. The selected target needs only the host's focus handoff.
 * Native/modified clicks use the complete href supplied to the controlled view.
 */
export const makeCodeReviewNavigation = ({ navigate, page, selection }: CodeReviewNavigationOptions) => {
  const hrefForThread = (thread: CodeReviewThreadTarget): string =>
    moduleHref(codeModule, page, codeSelectionSearch({ ...selection, view: "review", thread }))
  const currentHref = moduleHref(codeModule, page, codeSelectionSearch(selection))
  return {
    hrefForThread,
    onOpenThread: (thread: CodeReviewThreadTarget): void => {
      const href = hrefForThread(thread)
      if (href !== currentHref) navigate(href, "push", null)
    }
  }
}

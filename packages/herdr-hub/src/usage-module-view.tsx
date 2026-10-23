/**
 * The hub's built-in Usage module: the Usage pages from `@knpkv/herdr-usage/views`, given the superapp's mount,
 * links and header chrome. The page itself, its reads and its rendering live in that package.
 *
 * @module
 */
import {
  type UsageModuleContent,
  type UsageModuleReads,
  UsagePage,
  type UsagePageId,
  type UsageShell
} from "@knpkv/herdr-usage/views"
import { type ReactElement, useContext, useMemo } from "react"
import { UsageEmptyChromeContext } from "./internal/usage-empty-chrome.js"
import { ShellIcon } from "./internal/shell-icon.js"
import { moduleHref, type ModulePageMount, type ModuleViews, usageModule } from "./modules.js"

export type { UsageModuleReads }

const UsageModulePage = ({
  content,
  mount,
  page,
  search
}: {
  readonly content: UsageModuleContent
  readonly mount: ModulePageMount
  readonly page: UsagePageId
  readonly search: URLSearchParams
}): ReactElement => {
  const chrome = useContext(UsageEmptyChromeContext)
  const shell = useMemo(
    (): UsageShell => ({
      active: mount.active,
      navigate: (href) => mount.navigate(href, "replace", null),
      href: (target, selectors) => moduleHref(usageModule, target, selectors),
      chrome,
      nextIcon: <ShellIcon name="next" />
    }),
    [mount.active, mount.navigate, chrome]
  )
  return <UsagePage content={content} shell={shell} page={page} search={search} />
}

/** The shared page root keeps prior readings across tabs and shell navigation; Fleet owns transport. */
export const makeUsageModuleViews = (content: UsageModuleContent): ModuleViews<typeof usageModule> => ({
  descriptor: usageModule,
  navigationIcon: <ShellIcon name="usage" />,
  pages: {
    limits: (search, mount) => <UsageModulePage content={content} mount={mount} page="limits" search={search} />,
    tokens: (search, mount) => <UsageModulePage content={content} mount={mount} page="tokens" search={search} />,
    "by-tool": (search, mount) => <UsageModulePage content={content} mount={mount} page="by-tool" search={search} />
  }
})

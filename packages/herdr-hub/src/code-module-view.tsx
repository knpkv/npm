import { CodeHostView, type CodeHostPage } from "@knpkv/codecommit-web/views"
import type { CodeDiffContentResult, CodeDiffResult, CodeReference } from "@knpkv/codecommit-web/host"
import { Effect } from "effect"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { type CodeModuleReads } from "./code-client.js"
import {
  canonicalCodeSelection,
  codeSelectionForReference,
  codeSelectionSearch as selectionSearch,
  type CodeSelection
} from "./code-selection.js"
import { focusModulePage } from "./internal/shell-keys.js"
import { useCodeRead } from "./internal/use-code-read.js"
import { CodeCanvasPage } from "./code-canvas-page.js"
import { useCodeReviewWorkspace } from "./code-review-workspace.js"
import { ShellIcon } from "./internal/shell-icon.js"
import { codeModule, moduleHref, type ModulePageMount, type ModuleViews } from "./modules.js"

interface CodeModuleContent {
  readonly reads: CodeModuleReads
  readonly onHubMachine: boolean
}

const CodePage = ({
  content,
  mount,
  page,
  search
}: {
  readonly content: CodeModuleContent
  readonly page: CodeHostPage
  readonly search: URLSearchParams
  readonly mount: ModulePageMount
}) => {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible")
  const [refresh, setRefresh] = useState(0)
  const [repaired, setRepaired] = useState(false)
  const query = search.toString()
  const canonical = useMemo(() => canonicalCodeSelection(new URLSearchParams(query), page), [query, page])
  const selection = canonical.selection
  const current = useRef({ mount, page })
  useLayoutEffect(() => {
    current.current = { mount, page }
  }, [mount, page])
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", changed)
    return () => document.removeEventListener("visibilitychange", changed)
  }, [])
  useEffect(() => {
    if (!mount.active || canonical.search.toString() === query) return
    if (canonical.repaired) setRepaired(true)
    mount.navigate(moduleHref(codeModule, page, canonical.search), "replace", null)
  }, [mount.active, mount.navigate, canonical, query, page])
  const enabled = mount.active && visible
  const queueKey = JSON.stringify([selection.filter, selection.search, selection.offset])
  const queueRead = useMemo(
    () => content.reads.queue({ filter: selection.filter, search: selection.search, offset: selection.offset }),
    [content.reads.queue, selection.filter, selection.search, selection.offset]
  )
  const queue = useCodeRead(queueKey, queueRead, enabled, true, refresh)
  const ref = selection.ref
  const detailRead = useMemo(
    () => (ref === null ? Effect.never : content.reads.detail(ref)),
    [content.reads.detail, ref]
  )
  // Detail is a cache-only poll, including deep-linked diffs whose PR is absent from the queue page.
  const detail = useCodeRead(ref ?? "none", detailRead, enabled && ref !== null, true, refresh)
  const reviewWorkspace = useCodeReviewWorkspace({
    reads: content.reads,
    selection,
    page,
    mount,
    enabled: enabled && page !== "diffs" && selection.view !== "canvas",
    ownerUIHref: content.onHubMachine && queue.failure === null ? (queue.value?.ownerUi ?? null) : null
  })
  const diffRead = useMemo(() => (ref === null ? Effect.never : content.reads.diff(ref)), [content.reads.diff, ref])
  const diff = useCodeRead<CodeDiffResult>(
    ref ?? "none",
    diffRead,
    enabled && ref !== null && page === "diffs",
    false,
    refresh
  )
  const inventory = diff.value?._tag === "Ready" ? diff.value.diff : null
  const file = selection.file
  useEffect(() => {
    if (!mount.active || inventory === null || file === null || inventory.files.some((entry) => entry.index === file))
      return
    const next = selectionSearch({ ...selection, file: null })
    setRepaired(true)
    mount.navigate(moduleHref(codeModule, page, next), "replace", null)
  }, [mount.active, mount.navigate, inventory, file, selection, page])
  const contentQuery = useMemo(
    () =>
      ref !== null && inventory !== null && file !== null && inventory.files.some((entry) => entry.index === file)
        ? {
            ref,
            revisionId: inventory.revisionId,
            baseCommit: inventory.baseCommit,
            headCommit: inventory.headCommit,
            fileIndex: file
          }
        : null,
    [ref, inventory, file]
  )
  const contentRead = useMemo(
    () => (contentQuery === null ? Effect.never : content.reads.content(contentQuery)),
    [content.reads.content, contentQuery]
  )
  const fileReading = useCodeRead<CodeDiffContentResult>(
    JSON.stringify(contentQuery),
    contentRead,
    enabled && page === "diffs" && contentQuery !== null,
    false,
    refresh
  )
  const change = (next: CodeSelection, history: "push" | "replace") => {
    setRepaired(false)
    mount.navigate(moduleHref(codeModule, page, selectionSearch(next)), history, null)
  }
  const restoreFocus = useCallback((opener: HTMLElement | null): boolean => {
    const latest = current.current
    if (!latest.mount.active) return true // The shell has already focused the other module.
    if (latest.page === "diffs" || opener === document.body || opener?.isConnected !== true) {
      focusModulePage("code", latest.page)
      return true
    }
    return false
  }, [])
  const hrefFor = (target: CodeReference) =>
    moduleHref(codeModule, page, selectionSearch(codeSelectionForReference(selection, target)))
  const hrefForFile = (index: number) => moduleHref(codeModule, page, selectionSearch({ ...selection, file: index }))
  const tabHref = (target: CodeHostPage) => {
    const queueReturn = target === page && ref !== null && page !== "diffs"
    return moduleHref(
      codeModule,
      target,
      selectionSearch({
        ...selection,
        ref: queueReturn ? null : selection.ref,
        view: queueReturn ? "review" : selection.view,
        thread: queueReturn ? null : selection.thread,
        filter: target === "reviews" ? "reviews" : page === "reviews" ? "open" : selection.filter,
        offset: 0,
        file: null
      })
    )
  }
  if (ref !== null && page !== "diffs" && selection.view === "canvas") {
    return (
      <CodeCanvasPage
        enabled={enabled}
        ownerUIHref={content.onHubMachine && queue.failure === null ? (queue.value?.ownerUi ?? null) : null}
        reads={content.reads}
        refresh={refresh}
        selection={{ ...selection, ref }}
      />
    )
  }
  return (
    <>
      {repaired ? (
        <p className="code-host-selection-notice" role="status">
          Some Code selectors were invalid and have been reset.
        </p>
      ) : null}
      <CodeHostView
        active={mount.active}
        page={page}
        queue={queue}
        detail={detail}
        diff={diff}
        content={fileReading}
        query={selection}
        selected={ref}
        selectedFile={selection.file}
        tabs={{
          "pull-requests": { label: "Pull requests", href: tabHref("pull-requests") },
          reviews: { label: "Reviews", href: tabHref("reviews") },
          diffs: { label: "Diffs", href: tabHref("diffs") }
        }}
        hrefFor={hrefFor}
        hrefForFile={hrefForFile}
        onOpenReference={(target) => {
          if (selection.ref === target && selection.file === null) return
          change(codeSelectionForReference(selection, target), "push")
        }}
        nextHref={
          queue.value?._tag === "Ready" && queue.value.more && selection.offset <= 9950
            ? moduleHref(
                codeModule,
                page,
                selectionSearch({ ...selection, offset: selection.offset + 50, ref: null, file: null })
              )
            : null
        }
        ownerUIHref={
          content.onHubMachine && !queue.loading && queue.failure === null ? (queue.value?.ownerUi ?? null) : null
        }
        onSearch={(text) => change({ ...selection, search: text, offset: 0 }, "replace")}
        onFilter={(filter) => change({ ...selection, filter, offset: 0 }, "replace")}
        onClose={() => {
          setRepaired(false)
          mount.closeSelection(
            moduleHref(
              codeModule,
              page,
              selectionSearch({ ...selection, ref: null, file: null, view: "review", thread: null })
            )
          )
        }}
        onRefresh={() => {
          setRefresh((value) => value + 1)
          reviewWorkspace.readAgain()
        }}
        restoreFocus={restoreFocus}
        reviewWorkspace={reviewWorkspace.node}
        reviewBeforeDetail={reviewWorkspace.beforeDetail}
        reviewStatus={reviewWorkspace.status}
        reviewChecks={reviewWorkspace.checks}
      />
    </>
  )
}

/** One retained page instance owns Code's query selection; reads stop outside the active visible module. */
export const makeCodeModuleViews = (content: CodeModuleContent): ModuleViews<typeof codeModule> => {
  const page = (id: CodeHostPage) => (search: URLSearchParams, mount: ModulePageMount) => (
    <CodePage content={content} page={id} search={search} mount={mount} />
  )
  return {
    descriptor: codeModule,
    navigationIcon: <ShellIcon name="code" />,
    pages: { "pull-requests": page("pull-requests"), reviews: page("reviews"), diffs: page("diffs") }
  }
}

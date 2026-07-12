type ReleaseTransitionKind = "close" | "full"

interface ViewTransitionHandle {
  readonly finished: Promise<void>
}

type ViewTransitionDocument = Document & {
  readonly startViewTransition: (update: () => void) => ViewTransitionHandle
}

const supportsViewTransitions = (candidate: Document): candidate is ViewTransitionDocument =>
  "startViewTransition" in candidate && typeof candidate.startViewTransition === "function"

/**
 * Keeps release navigation usable everywhere while progressively enhancing the
 * preview-to-page handoff in browsers that support same-document transitions.
 */
export function runReleaseViewTransition(
  update: () => void,
  kind: ReleaseTransitionKind = "full"
) {
  const root = document.documentElement
  if (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    || !supportsViewTransitions(document)
  ) {
    update()
    return
  }

  root.dataset.ccReleaseTransition = kind
  const transition = document.startViewTransition(update)
  void transition.finished.finally(() => {
    delete root.dataset.ccReleaseTransition
  })
}

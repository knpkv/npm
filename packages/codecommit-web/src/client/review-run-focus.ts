/** Move pane-owned focus before a review disables controls or replaces findings with progress. */
export const preserveReviewRunFocus = (pane: HTMLElement | null): void => {
  if (pane?.contains(pane.ownerDocument.activeElement) === true) pane.focus({ preventScroll: true })
}

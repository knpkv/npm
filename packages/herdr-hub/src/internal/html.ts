export const escapeHtmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")

/** "Relay" for the super-app; a host's own activity page names the host first. */
export const dashboardDocumentTitle = (page: {
  readonly approvalApp: { readonly superapp: boolean }
  readonly host: string
}): string => page.approvalApp.superapp ? "Relay" : `${escapeHtmlText(page.host)} on Relay`

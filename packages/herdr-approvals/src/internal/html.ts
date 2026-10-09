export const escapeHtmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")

/** "Relay" on the hub itself; a host's own activity page names the host first. */
export const dashboardDocumentTitle = (page: {
  readonly approvalApp: { readonly canonical: boolean }
  readonly host: string
}): string => page.approvalApp.canonical ? "Relay" : `${escapeHtmlText(page.host)} on Relay`

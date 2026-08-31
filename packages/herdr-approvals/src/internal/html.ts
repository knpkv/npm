export const escapeHtmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")

export const dashboardDocumentTitle = (host: string): string => `Host activity · ${escapeHtmlText(host)}`

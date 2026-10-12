/** Evaluate in the browser. Only pinned Radix CSSOM effects inside the detail tabs are accepted. */
export const rejectedViewStyles = (): ReadonlyArray<string> => {
  const rejected: Array<string> = Array.from(document.querySelectorAll("style"), () => "style element")
  for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
    const declarations = element.style
    const tabs = element.closest(".ac-detail-tabs")
    const role = element.getAttribute("role")
    const isList = element.classList.contains("rly_Tabs-module__list") && role === "tablist"
    const isPanel = element.classList.contains("rly_Tabs-module__panel") && role === "tabpanel"
    // Chromium exposes outline shorthand through multiple CSSOM longhands; normalized cssText stays exact.
    const allowedDeclaration = isList ?
      declarations.cssText === "outline: none;" :
      declarations.cssText === "animation-duration: 0s;" || declarations.cssText === ""
    const allowed = element.tagName === "DIV" && tabs !== null && (isList || isPanel) && allowedDeclaration
    if (!allowed) rejected.push(`${element.tagName} ${role ?? "no role"}: ${element.getAttribute("style") ?? ""}`)
  }
  return rejected
}

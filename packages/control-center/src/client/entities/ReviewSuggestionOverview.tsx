import type { ReactElement } from "react"

import type { CompleteDiffInventoryEntry } from "../../api/diff.js"
import type { PrReviewSuggestion } from "../../domain/prReview.js"
import styles from "./WorkspacePullRequestDiff.module.css"

const scopeKinds = ["file", "changes"] satisfies ReadonlyArray<"file" | "changes">

/** Group file- and change-scoped advice while keeping inventory-backed locations navigable. */
export const ReviewSuggestionOverview = ({
  entries,
  onNavigate,
  onSelectAnchor,
  suggestions
}: {
  readonly entries: ReadonlyArray<CompleteDiffInventoryEntry>
  readonly onNavigate: (fileId: string, lineNumber?: number) => void
  readonly onSelectAnchor: (anchor: Extract<PrReviewSuggestion["anchor"], { readonly _tag: "file" }>) => void
  readonly suggestions: ReadonlyArray<PrReviewSuggestion>
}): ReactElement | null => {
  const overviewSuggestions = suggestions.filter(({ anchor }) => anchor._tag !== "line")
  if (overviewSuggestions.length === 0) return null
  return (
    <section aria-label="File and whole-change suggestions" className={styles.overview}>
      <header>
        <span>Review overview</span>
        <strong>{overviewSuggestions.length}</strong>
      </header>
      {scopeKinds.map((scopeKind) => {
        const scoped = overviewSuggestions.filter(({ anchor }) => anchor._tag === scopeKind)
        if (scoped.length === 0) return null
        return (
          <section key={scopeKind}>
            <h3>{scopeKind === "file" ? "File suggestions" : "Whole-change suggestions"}</h3>
            <ul>
              {scoped.map((suggestion) => {
                const anchor = suggestion.anchor
                return (
                  <li data-severity={suggestion.severity} key={suggestion.suggestionId}>
                    <span>
                      {suggestion.severity} · {suggestion.state}
                    </span>
                    <strong>{suggestion.title}</strong>
                    <p>{suggestion.problem}</p>
                    {anchor._tag !== "file" ? null : (
                      <button onClick={() => onSelectAnchor(anchor)} type="button">
                        {anchor.path}:{String(anchor.line)}
                      </button>
                    )}
                    {suggestion.relatedLocations.length === 0 ? null : (
                      <details>
                        <summary>Related locations</summary>
                        <ul>
                          {suggestion.relatedLocations.map((location) => {
                            const entry = entries.find(({ path }) => String(path) === String(location.path))
                            const label = (
                              <>
                                {location.path}:{String(location.startLine)}
                                {location.endLine === location.startLine ? "" : `–${String(location.endLine)}`}
                              </>
                            )
                            return (
                              <li key={`${location.path}:${String(location.startLine)}:${String(location.endLine)}`}>
                                {entry === undefined ? (
                                  <code>{label}</code>
                                ) : (
                                  <button onClick={() => onNavigate(entry.anchor, location.startLine)} type="button">
                                    {label}
                                  </button>
                                )}
                                <span>{location.label}</span>
                              </li>
                            )
                          })}
                        </ul>
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </section>
  )
}

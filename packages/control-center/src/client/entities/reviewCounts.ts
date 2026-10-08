const counted = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

/** A review report's counts as people read them: "1 suggestion · 0 notes". */
export const reviewCountsLabel = (suggestions: number, notes: number): string =>
  `${counted(suggestions, "suggestion", "suggestions")} · ${counted(notes, "note", "notes")}`

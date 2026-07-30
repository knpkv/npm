export interface ApplicationLogSurface {
  readonly browserConsole: ReadonlyArray<string>
  readonly managedRuntime: ReadonlyArray<string>
}

export interface ApplicationLogForbiddenValue {
  readonly label: string
  readonly value: string
}

const logEntriesExposeValue = (entries: ReadonlyArray<string>, value: string): boolean =>
  value.length > 0 && entries.some((entry) => entry.includes(value))

/** Report only labels so a failed assertion never repeats a captured secret. */
export const exposedApplicationLogForbiddenValues = (
  surface: ApplicationLogSurface,
  forbiddenValues: ReadonlyArray<ApplicationLogForbiddenValue>
): ReadonlyArray<string> =>
  forbiddenValues
    .filter(({ value }) =>
      logEntriesExposeValue(surface.browserConsole, value) ||
      logEntriesExposeValue(surface.managedRuntime, value)
    )
    .map(({ label }) => label)

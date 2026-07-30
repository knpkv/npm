import type { ConsoleMessage, JSHandle, Page } from "@playwright/test"

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

const serializeConsoleArgument = async (handle: JSHandle): Promise<string> =>
  await handle.evaluate((value) => {
    const maxDepth = 5
    const maxEntries = 50
    const maxStringLength = 16_000
    const seen = new WeakSet<object>()
    const visit = (candidate: unknown, depth: number): unknown => {
      if (typeof candidate === "string") return candidate.slice(0, maxStringLength)
      if (
        candidate === null ||
        typeof candidate === "boolean" ||
        typeof candidate === "number" ||
        typeof candidate === "undefined"
      ) {
        return candidate
      }
      if (typeof candidate === "bigint" || typeof candidate === "symbol" || typeof candidate === "function") {
        return `[${typeof candidate}]`
      }
      if (depth >= maxDepth) return "[maximum depth]"
      if (seen.has(candidate)) return "[circular]"
      seen.add(candidate)
      try {
        const descriptors = Object.entries(Object.getOwnPropertyDescriptors(candidate)).slice(0, maxEntries)
        if (Array.isArray(candidate)) {
          return descriptors
            .filter(([key]) => /^\d+$/u.test(key))
            .map(([, descriptor]) => "value" in descriptor ? visit(descriptor.value, depth + 1) : "[accessor]")
        }
        return Object.fromEntries(
          descriptors.map(([key, descriptor]) => [
            key.slice(0, 200),
            "value" in descriptor ? visit(descriptor.value, depth + 1) : "[accessor]"
          ])
        )
      } catch {
        return "[unserializable object]"
      }
    }
    return (JSON.stringify(visit(value, 0)) ?? "[undefined]").slice(0, maxStringLength)
  })

/** Capture only exact-origin page logs, recursively serializing bounded data properties without invoking getters. */
export const serializeApplicationConsoleMessage = async (
  page: Page,
  message: ConsoleMessage,
  applicationOrigin: string
): Promise<string | null> => {
  const sourceUrl = message.location().url
  const effectiveSourceUrl = sourceUrl.length === 0 ? page.url() : sourceUrl
  try {
    if (new URL(effectiveSourceUrl).origin !== applicationOrigin) return null
  } catch {
    return null
  }
  const argumentsSerialized = await Promise.all(
    message.args().slice(0, 20).map(serializeConsoleArgument)
  )
  return JSON.stringify({
    arguments: argumentsSerialized,
    text: message.text().slice(0, 16_000)
  })
}

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

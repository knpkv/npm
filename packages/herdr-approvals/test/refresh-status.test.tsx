/** A failed refresh is announced in a status region that was already mounted. */
import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { RefreshStatus } from "../src/refresh-status.js"

const noop = () => undefined

describe("hub refresh status", () => {
  it("keeps an empty polite status region mounted while refreshes succeed", () => {
    const markup = renderToStaticMarkup(<RefreshStatus failed={false} observedAt={1_000} onRetry={noop} />)
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).not.toContain("Couldn&#x27;t refresh")
  })

  it("puts the failure and its retry inside that same region", () => {
    const markup = renderToStaticMarkup(<RefreshStatus failed observedAt={1_000} onRetry={noop} />)
    const region = markup.indexOf('role="status"')
    expect(region).toBeGreaterThanOrEqual(0)
    expect(markup.indexOf("Couldn&#x27;t refresh host activity")).toBeGreaterThan(region)
    expect(markup).toContain("Try again")
    expect(markup).toContain('dateTime="1970-01-01T00:00:01.000Z"')
  })
})

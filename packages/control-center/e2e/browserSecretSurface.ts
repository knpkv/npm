/** Browser-owned text surfaces that must never reveal an HttpOnly session secret. */
export interface BrowserSecretSurface {
  readonly documentHtml: string
  readonly liveFormControlValues: string
  readonly localStorage: string
  readonly openShadowRootContent: string
  readonly sessionStorage: string
  readonly url: string
}

export interface BrowserForbiddenValue {
  readonly label: string
  readonly value: string
}

/** Detect a value in any browser-readable surface without assuming a storage key. */
export const browserSurfaceExposesSecret = (surface: BrowserSecretSurface, secret: string): boolean =>
  Object.values(surface).some((value) => value.includes(secret))

/** Return labels only, so a failed assertion never prints the forbidden values themselves. */
export const exposedBrowserForbiddenValues = (
  surface: BrowserSecretSurface,
  forbiddenValues: ReadonlyArray<BrowserForbiddenValue>
): ReadonlyArray<string> =>
  forbiddenValues
    .filter(({ value }) => browserSurfaceExposesSecret(surface, value))
    .map(({ label }) => label)

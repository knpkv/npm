/** Browser-owned text surfaces that must never reveal an HttpOnly session secret. */
export interface BrowserSecretSurface {
  readonly documentHtml: string
  readonly localStorage: string
  readonly sessionStorage: string
  readonly url: string
}

/** Detect a secret in any browser-readable surface without assuming a storage key. */
export const browserSurfaceExposesSecret = (surface: BrowserSecretSurface, secret: string): boolean =>
  Object.values(surface).some((value) => value.includes(secret))

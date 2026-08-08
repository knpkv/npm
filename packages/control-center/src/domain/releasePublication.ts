import type { ReleaseVersion } from "./release.js"

/** Canonical owner-visible title shared by explicit and natural-language publication paths. */
export const canonicalReleasePublicationTitle = (version: ReleaseVersion): string => `${version} release`

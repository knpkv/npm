import manifest from "../../package.json" with { type: "json" }

/** Bundlers inline this package metadata so relocated executables need no manifest file. */
export const relayVersion = manifest.version

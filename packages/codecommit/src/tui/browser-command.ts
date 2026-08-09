/**
 * Builds the Granted arguments for opening an exact console destination.
 * `--cd` is a long-option alias; `-cd` is parsed as `-c` plus `-d`.
 */
export const assumeConsoleArgs = (link: string, profile: string): ReadonlyArray<string> => ["--cd", link, profile]

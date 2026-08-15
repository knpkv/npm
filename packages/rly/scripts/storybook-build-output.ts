const ansiEscape = new RegExp(
  String.raw`\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))`,
  "gu"
)

const disallowedDiagnosticCodes: ReadonlyArray<string> = ["[DEP0205]", "[PLUGIN_TIMINGS]"]

export const findDisallowedStorybookDiagnostics = (output: string): ReadonlyArray<string> => {
  const normalized = output.replaceAll(ansiEscape, "")
  return disallowedDiagnosticCodes.filter((code) => normalized.includes(code))
}

export const assertWarningFreeStorybookOutput = (output: string): void => {
  const diagnostics = findDisallowedStorybookDiagnostics(output)
  if (diagnostics.length > 0) {
    throw new Error(`Storybook emitted disallowed build diagnostics: ${diagnostics.join(", ")}`)
  }
}

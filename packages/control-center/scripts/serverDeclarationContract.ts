/** Emitted declaration barrels that make up the public server export chain. */
export interface ServerDeclarationContractSources {
  readonly authIndex: string
  readonly persistenceIndex: string
  readonly serverIndex: string
}

const containsIdentifier = (source: string, identifier: string): boolean =>
  new RegExp(`\\b${identifier}\\b`, "u").test(source)

const exportsEveryValueFrom = (source: string, moduleName: string): boolean =>
  new RegExp(`\\bexport\\s*\\*\\s*from\\s*["']\\./${moduleName}\\.js["']`, "u").test(source)

/** Return internal database-layer factories exposed by the public server declaration chain. */
export const inspectServerDeclarationContract = (
  sources: ServerDeclarationContractSources
): ReadonlyArray<string> => {
  const violations: Array<string> = []

  if (
    containsIdentifier(sources.authIndex, "authLayerFromDatabase") ||
    exportsEveryValueFrom(sources.authIndex, "Auth") ||
    containsIdentifier(sources.serverIndex, "authLayerFromDatabase")
  ) {
    violations.push("public server declarations expose authLayerFromDatabase")
  }

  if (
    containsIdentifier(sources.persistenceIndex, "persistenceLayerFromDatabase") ||
    exportsEveryValueFrom(sources.persistenceIndex, "Persistence") ||
    containsIdentifier(sources.serverIndex, "persistenceLayerFromDatabase")
  ) {
    violations.push("public server declarations expose persistenceLayerFromDatabase")
  }

  return violations
}

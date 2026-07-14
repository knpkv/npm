import type { Plugin } from "vite"

const normalizeModuleId = (moduleId: string): string =>
  moduleId.split("?", 1)[0]?.replaceAll("\\", "/") ?? moduleId.replaceAll("\\", "/")

/** Return reachable production modules that resolve inside the prototype fixture tree. */
export const inspectProductionPrototypeModules = (
  moduleIds: Iterable<string>,
  clientRoot: string
): ReadonlyArray<string> => {
  const normalizedRoot = normalizeModuleId(clientRoot).replace(/\/$/u, "")
  const prototypeRoots = [`${normalizedRoot}/prototype/`, `${normalizedRoot}/prototypes/`]
  return Array.from(moduleIds, normalizeModuleId)
    .filter((moduleId) => prototypeRoots.some((prototypeRoot) => moduleId.startsWith(prototypeRoot)))
    .sort()
}

/** Fail a production build if a static, computed, or glob import reaches a prototype fixture. */
export const productionPrototypeBoundary = (clientRoot: string): Plugin => ({
  name: "codecommit-production-prototype-boundary",
  apply: "build",
  generateBundle() {
    const violations = inspectProductionPrototypeModules(this.getModuleIds(), clientRoot)
    if (violations.length > 0) {
      this.error(
        `Production client graph includes prototype fixture modules:\n${violations.map((id) => `- ${id}`).join("\n")}`
      )
    }
  }
})

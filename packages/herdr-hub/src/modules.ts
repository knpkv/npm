import { Result } from "effect"
import type { ReactNode } from "react"
import {
  type ModuleDescriptor,
  ModuleRegistrationError,
  moduleRegistryFingerprint,
  validateModuleRegistry
} from "./module-contract.js"

export * from "./module-contract.js"
export * from "./module-navigation.js"
export * from "./module-needs-you.js"
export * from "./usage-selection.js"

/**
 * The shell owns history. Build exact links with moduleHref; focus defaults to the destination
 * page. Pass null for in-page selector updates to retain control focus, or search for Connect.
 */
export interface ModulePageMount {
  readonly active: boolean
  readonly navigate: (href: string, history: "push" | "replace", focus?: "page" | "search" | null) => void
}

/** Browser implementations import a product's browser entry and supply every declared page. */
export interface ModuleViews<D extends ModuleDescriptor> {
  readonly descriptor: D
  readonly pages: {
    readonly [P in D["pages"][number]["id"]]: (search: URLSearchParams, mount: ModulePageMount) => ReactNode
  }
}

/** Check page implementations and shared metadata before the shell renders a module. */
export const makeModuleViews = <const V extends ReadonlyArray<ModuleViews<ModuleDescriptor>>>(
  descriptors: ReadonlyArray<ModuleDescriptor>,
  views: V
): Result.Result<V, ModuleRegistrationError> => {
  const validated = validateModuleRegistry(descriptors)
  if (Result.isFailure(validated)) return Result.fail(validated.failure)
  const browserDescriptors = validateModuleRegistry(views.map((view) => view.descriptor))
  if (Result.isFailure(browserDescriptors)) return Result.fail(browserDescriptors.failure)
  if (moduleRegistryFingerprint(descriptors) !== moduleRegistryFingerprint(views.map((view) => view.descriptor))) {
    return Result.fail(new ModuleRegistrationError({ module: "registry", reason: "browser_mismatch" }))
  }
  for (const view of views) {
    const pageIds = Object.keys(view.pages).sort()
    const declared = view.descriptor.pages.map((page) => page.id).sort()
    if (pageIds.length !== declared.length || pageIds.some((id, index) => id !== declared[index])) {
      return Result.fail(new ModuleRegistrationError({ module: view.descriptor.id, reason: "browser_mismatch" }))
    }
  }
  return Result.succeed(views)
}

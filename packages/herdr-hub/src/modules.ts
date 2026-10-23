import { Result } from "effect"
import type { ReactNode } from "react"
import {
  type ModuleDescriptor,
  ModuleRegistrationError,
  moduleRegistryFingerprint,
  validateModuleRegistry
} from "./module-contract.js"

export * from "@knpkv/herdr-usage/selection"
export * from "./module-contract.js"
export * from "./module-navigation.js"
export * from "./module-needs-you.js"

/**
 * The shell owns history. Build exact links with moduleHref; focus defaults to the destination
 * page. Pass null for in-page selector updates to retain control focus, or search for Connect.
 */
export interface ModulePageMount {
  /**
   * Gate portals/focus traps on active; hidden sections do not hide portals. Keep underlying owners alive.
   * Move owned arrival focus in the activation effect; the shell keeps focus claimed inside the destination.
   */
  readonly active: boolean
  readonly navigate: (href: string, history: "push" | "replace", focus?: "page" | "search" | null) => void
  /**
   * Close a target opened with navigate(..., "push"). Return through Back only when this
   * shell lifetime opened it directly from parentHref; direct/reloaded/remounted targets replace instead.
   * Selector filters still use navigate(..., "replace"). The closing modal owns focus.
   */
  readonly closeSelection: (parentHref: string) => void
  /** Open the shell’s existing Host access sheet; custom mount hosts may omit it. */
  readonly openHostAccess?: () => void
}

/** Browser implementations import a product's browser entry and supply every declared page. */
export interface ModuleViews<D extends ModuleDescriptor> {
  readonly descriptor: D
  /** Optional decorative navigation glyph. The shell supplies the visible and accessible module name. */
  readonly navigationIcon?: ReactNode
  /** A bounded reading supplied by the module owner; label states any partial or stale semantics. */
  readonly navigationBadge?: { readonly text: string; readonly label: string }
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

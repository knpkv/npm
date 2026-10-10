import { Result, Schema } from "effect"
import { fleetModule, type ModuleDescriptor, type ModuleDestination } from "./module-contract.js"

export class ModuleRouteNotFound extends Schema.TaggedError<ModuleRouteNotFound>()("ModuleRouteNotFound", {
  hash: Schema.String
}) {}

/**
 * Decode only registered module/page pairs; a bare module hash opens its default page.
 * The overload trusts this narrowing because decoding can only yield those registered pairs.
 */
export function readModuleRoute<const Ds extends ReadonlyArray<ModuleDescriptor>>(
  url: URL,
  descriptors: Ds
): Result.Result<ModuleDestination<Ds[number]>, ModuleRouteNotFound>
export function readModuleRoute(
  url: URL,
  descriptors: ReadonlyArray<ModuleDescriptor>
): Result.Result<ModuleDestination, ModuleRouteNotFound> {
  for (const descriptor of descriptors) {
    const grammar = Schema.Union([
      Schema.TemplateLiteralParser(["#", Schema.Literal(descriptor.id)]),
      Schema.TemplateLiteralParser([
        "#",
        Schema.Literal(descriptor.id),
        "/",
        Schema.Literals(descriptor.pages.map((page) => page.id))
      ])
    ])
    const decoded = Schema.decodeUnknownResult(grammar)(url.hash)
    if (Result.isSuccess(decoded)) {
      const page = decoded.success.length === 2 ? descriptor.defaultPage : decoded.success[3]
      if (!descriptor.pages.some((registered) => registered.id === page)) {
        return Result.fail(new ModuleRouteNotFound({ hash: url.hash }))
      }
      return Result.succeed({
        module: decoded.success[1],
        page
      })
    }
  }
  return Result.fail(new ModuleRouteNotFound({ hash: url.hash }))
}

/** Rewrite a legacy tab link without changing its document or object-selection parameters. */
const canonicalUrl = (
  source: URL,
  descriptors: ReadonlyArray<ModuleDescriptor>,
  landing: ModuleDestination | null
): Result.Result<URL, ModuleRouteNotFound> => {
  const url = new URL(source)
  if (url.hash === "") {
    const tab = url.searchParams.get("tab")
    if (tab !== null) url.hash = `${fleetModule.id}/${tab}`
    else {
      if (landing === null) return Result.fail(new ModuleRouteNotFound({ hash: "" }))
      url.hash = `${landing.module}/${landing.page}`
    }
  }
  const route = readModuleRoute(url, descriptors)
  if (Result.isFailure(route)) return Result.fail(route.failure)
  url.searchParams.delete("tab")
  return Result.succeed(url)
}

/** Rewrite a legacy tab link using the application's explicit registry and landing page. */
export const canonicalModuleUrl = <const Ds extends ReadonlyArray<ModuleDescriptor>>(
  source: URL,
  descriptors: Ds,
  landing: NoInfer<ModuleDestination<Ds[number]>>
): Result.Result<URL, ModuleRouteNotFound> => canonicalUrl(source, descriptors, landing)

/** Build an exact page link. Object selectors remain query parameters owned by that page. */
export const moduleHref = <const D extends ModuleDescriptor>(
  descriptor: D,
  page: NoInfer<D["pages"][number]["id"]>,
  search: URLSearchParams = new URLSearchParams()
): string => {
  const query = new URLSearchParams(search)
  query.delete("tab")
  const encoded = query.toString()
  return `?${encoded}#${descriptor.id}/${page}`
}

/** Intercept only plain same-document module links; callers also exclude downloads and targets. */
export const moduleLinkTarget = (
  href: string,
  current: URL,
  click: {
    readonly button: number
    readonly altKey: boolean
    readonly ctrlKey: boolean
    readonly metaKey: boolean
    readonly shiftKey: boolean
  },
  descriptors: ReadonlyArray<ModuleDescriptor>
): Result.Result<URL, ModuleRouteNotFound> | null => {
  if (
    click.button !== 0 ||
    click.altKey ||
    click.ctrlKey ||
    click.metaKey ||
    click.shiftKey ||
    !URL.canParse(href, current)
  ) {
    return null
  }
  const target = new URL(href, current)
  if (target.origin !== current.origin || target.pathname !== current.pathname) return null
  const knownNamespace = Schema.Union(
    descriptors.map((descriptor) =>
      Schema.Union([Schema.Literal(`#${descriptor.id}`), Schema.TemplateLiteral([`#${descriptor.id}/`, Schema.String])])
    )
  )
  if (!target.searchParams.has("tab") && Result.isFailure(Schema.decodeUnknownResult(knownNamespace)(target.hash))) {
    return null
  }
  return canonicalUrl(target, descriptors, null)
}

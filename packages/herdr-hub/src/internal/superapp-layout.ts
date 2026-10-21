/**
 * Which installed modules the super-app shows, and where.
 *
 * @module
 */
const mobileOrder: ReadonlyArray<string> = ["connect", "fleet", "code", "usage"]
const primaryOrder: ReadonlyArray<string> = ["connect", "fleet"]

/** Module ids for the shell's sidebar, phone bar and primary group, each in display order. */
export interface SuperappLayout<Id extends string> {
  readonly modules: ReadonlyArray<Id>
  readonly mobileModules: ReadonlyArray<Id>
  readonly primaryModules: ReadonlyArray<Id>
}

/**
 * The shell's module ids for this host. A standalone host (`fleet` false) has no Fleet module, so it is
 * dropped from the sidebar and the phone bar, and the sidebar is one flat group with no divider.
 */
export const superappLayout = <Id extends string>(installed: ReadonlyArray<Id>, fleet: boolean): SuperappLayout<Id> => {
  const modules = installed.filter((id) => fleet || id !== "fleet")
  const pick = (order: ReadonlyArray<string>) => order.flatMap((id) => modules.filter((module) => module === id))
  return { modules, mobileModules: pick(mobileOrder), primaryModules: fleet ? pick(primaryOrder) : modules }
}

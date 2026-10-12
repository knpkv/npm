/** Build the retained public FleetShell legacy column around an embedded Connect fixture.
 * Canonical Connect Home has its own module-shell browser tests.
 */
export const mountLegacyFleetColumn = (main: HTMLElement): void => {
  main.classList.add("fleet-shell-main")
  const parent = main.parentElement
  const shell = parent?.classList.contains("fleet-shell") === true ? parent : document.createElement("div")
  shell.classList.add("fleet-shell")
  shell.dataset.fleetLayout = "legacy"
  if (shell !== parent) {
    main.before(shell)
    shell.append(main)
  }
}

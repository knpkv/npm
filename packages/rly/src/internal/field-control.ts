const registeredFieldControls = new WeakSet<object>()

/** Register an owned control that applies Field semantics to its final DOM host. */
export const registerFieldControl = <Component extends object>(component: Component): Component => {
  registeredFieldControls.add(component)
  return component
}

/** Distinguish rly-owned controls from consumer components that may discard DOM semantics. */
export const isRegisteredFieldControl = (component: object): boolean => registeredFieldControls.has(component)

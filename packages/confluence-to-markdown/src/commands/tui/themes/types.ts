/**
 * Theme type definition.
 */

export interface Theme {
  readonly name: string
  readonly bg: {
    readonly primary: string
    readonly secondary: string
    readonly tertiary: string
    readonly header: string
    readonly statusBar: string
  }
  readonly accent: {
    readonly primary: string
    readonly secondary: string
    readonly tertiary: string
    readonly success: string
    readonly warning: string
    readonly error: string
  }
  readonly text: {
    readonly primary: string
    readonly secondary: string
    readonly muted: string
    readonly inverse: string
  }
  readonly border: {
    readonly focused: string
    readonly unfocused: string
    readonly accent: string
  }
  readonly selection: {
    readonly active: string
    readonly inactive: string
    readonly hover: string
  }
  readonly status: {
    readonly synced: string
    readonly unsynced: string
    readonly loading: string
    readonly online: string
    readonly offline: string
  }
  readonly icons: {
    readonly synced: string
    readonly unsynced: string
    readonly folder: string
    readonly loading: string
    readonly bullet: string
    readonly dot: string
    readonly check: string
    readonly cross: string
    readonly arrow: {
      readonly up: string
      readonly down: string
      readonly left: string
      readonly right: string
    }
  }
}

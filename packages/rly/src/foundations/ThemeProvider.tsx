import {
  createContext,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useRef,
  useSyncExternalStore
} from "react"
import { requireText } from "../internal/component.js"
import { GlobalStyles, type GlobalStylesProps } from "./GlobalStyles.js"

const themeNames = <const Names extends ReadonlyArray<string>>(names: Names): Names => names

export const RLY_THEME_NAMES = themeNames(["system", "light", "dark"])
export type RlyTheme = (typeof RLY_THEME_NAMES)[number]

export type ThemeProviderProps = GlobalStylesProps & {
  readonly theme: RlyTheme
}

const ThemeContext = createContext<RlyTheme>("system")

/** Internal bridge used by portal-aware foundations without exposing context internals. */
export const useRlyTheme = (): RlyTheme => useContext(ThemeContext)

/** Controlled theme boundary. Pair it with `useStoredTheme` to remember the viewer's choice. */
export const ThemeProvider = ({ theme, ...props }: ThemeProviderProps): ReactElement => (
  <ThemeContext.Provider value={theme}>
    <GlobalStyles {...props} data-theme={theme} />
  </ThemeContext.Provider>
)

/** Decode an untrusted stored or submitted value into a theme name, or `undefined` when it is not one. */
export const decodeRlyTheme = (value: string | null | undefined): RlyTheme | undefined =>
  value === "system" || value === "light" || value === "dark" ? value : undefined

/** The storage operations `useStoredTheme` needs; the browser's local storage satisfies it. */
export type RlyPreferenceStorage = Pick<Storage, "getItem" | "setItem">

type PreferenceStorageIdentity = RlyPreferenceStorage | (() => RlyPreferenceStorage)

// Same-tab writers notify here; the `storage` event only reaches other tabs.
const sameTabListeners = new Set<(storage: PreferenceStorageIdentity, key: string) => void>()
// Holds a choice for this page lifetime when storage writes are refused.
const unsavedThemes = new WeakMap<PreferenceStorageIdentity, Map<string, RlyTheme>>()

/** Which store a hook talks to: its identity for fallbacks and sync, and the store when readable. */
interface StorageAccess {
  readonly identity: PreferenceStorageIdentity
  readonly readable: RlyPreferenceStorage | null
}

/** Use the storage object as identity, or the stable supplier when access is refused. */
const storageAccess = (storage: () => RlyPreferenceStorage, unavailable: () => RlyPreferenceStorage): StorageAccess => {
  try {
    const readable = storage()
    return { identity: readable, readable }
  } catch {
    return { identity: unavailable, readable: null }
  }
}

const readStoredTheme = (key: string, access: StorageAccess): RlyTheme => {
  const unsaved = unsavedThemes.get(access.identity)?.get(key)
  if (unsaved !== undefined) return unsaved
  if (access.readable === null) return "system"
  try {
    return decodeRlyTheme(access.readable.getItem(key)) ?? "system"
  } catch {
    return "system"
  }
}

const serverTheme = (): RlyTheme => "system"

/**
 * Remember the viewer's theme under an application-chosen key in storage the
 * application hands in. It is a viewer-local presentation preference, never
 * application data. Pass storage lazily, so server rendering never touches it and
 * a browser that refuses access falls back to `system`.
 *
 * The server snapshot is always `system`, so server-rendered pages hydrate and then
 * switch to the stored theme. Consumers sharing a storage object and key stay in sync;
 * native storage events sync other tabs using the same storage area. When storage
 * refuses the write, the choice lasts until unload or a matching storage update.
 * If access itself is refused, consumers share fallback choices only through the
 * same stable storage supplier. Inline suppliers keep their fallback across renders.
 *
 * @example
 * // browserStorage is an application function returning the browser's local storage.
 * const [theme, setTheme] = useStoredTheme("jcf_theme", browserStorage)
 * <ThemeProvider theme={theme}><ThemeSelect onValueChange={setTheme} value={theme} /></ThemeProvider>
 */
export const useStoredTheme = (
  storageKey: string,
  storage: () => RlyPreferenceStorage
): readonly [RlyTheme, (theme: RlyTheme) => void] => {
  const key = requireText(storageKey, "useStoredTheme storage key")

  const unavailableStorage = useRef(storage)
  // Callers usually pass an inline thunk; a ref keeps setTheme stable across renders. Insertion
  // effects run before any layout or passive effect, so a descendant's effect calling setTheme
  // already writes to the storage this render supplied.
  const storageRef = useRef(storage)
  useInsertionEffect(() => {
    storageRef.current = storage
  })

  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      const onStorage = (event: StorageEvent): void => {
        if (event.key !== key && event.key !== null) return
        const current = storageAccess(storageRef.current, unavailableStorage.current).identity
        if (event.storageArea !== current) return
        unsavedThemes.get(current)?.delete(key)
        notify()
      }
      const onSameTab = (changedStorage: PreferenceStorageIdentity, changed: string): void => {
        if (
          changed === key &&
          changedStorage === storageAccess(storageRef.current, unavailableStorage.current).identity
        )
          notify()
      }
      window.addEventListener("storage", onStorage)
      sameTabListeners.add(onSameTab)
      return () => {
        window.removeEventListener("storage", onStorage)
        sameTabListeners.delete(onSameTab)
      }
    },
    [key]
  )

  const theme = useSyncExternalStore(
    subscribe,
    () => readStoredTheme(key, storageAccess(storage, unavailableStorage.current)),
    serverTheme
  )

  const setTheme = useCallback(
    (next: RlyTheme): void => {
      let identity: PreferenceStorageIdentity = unavailableStorage.current
      try {
        const current = storageRef.current()
        identity = current
        current.setItem(key, next)
        unsavedThemes.get(identity)?.delete(key)
      } catch {
        const themes = unsavedThemes.get(identity) ?? new Map<string, RlyTheme>()
        themes.set(key, next)
        unsavedThemes.set(identity, themes)
      }
      for (const listener of sameTabListeners) listener(identity, key)
    },
    [key]
  )

  return [theme, setTheme]
}

/**
 * Apply the theme to the document root as well as the rly boundary, so the viewport
 * canvas, overscroll area, and page scrollbars follow the viewer's choice. Call it once,
 * next to `useStoredTheme`, in the application that owns the whole page; embedded rly
 * surfaces should not. The attribute is removed on unmount.
 */
export const useDocumentTheme = (theme: RlyTheme): void => {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    return () => {
      root.removeAttribute("data-theme")
    }
  }, [theme])
}

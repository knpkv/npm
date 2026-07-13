import { Dialog as RadixDialog } from "radix-ui"
import {
  type ComponentPropsWithRef,
  createContext,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import { Icon } from "../foundations/Icon.js"
import { PortalBoundary } from "../foundations/PortalProvider.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import {
  invalidateModalFocusRestore,
  isHTMLElement,
  restoreModalFocusAfterCleanup,
  useModalIsolation
} from "../internal/modal.js"
import styles from "./Sheet.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Semantic logical-side metadata for the sheet surface. */
export const RLY_SHEET_VARIANTS = defineVariants({
  side: {
    end: {
      className: style("end"),
      purpose: "Supporting detail that follows the current reading flow",
      tokens: ["color-surface-1", "radius-overlay", "motion-standard"]
    },
    start: {
      className: style("start"),
      purpose: "Navigation or context that precedes the current reading flow",
      tokens: ["color-surface-1", "radius-overlay", "motion-standard"]
    }
  }
})

/** Default logical edge used when no sheet side is selected. */
export const RLY_SHEET_DEFAULT_VARIANTS = defineVariants({ side: "end" })
/** Logical inline edges supported by a sheet. */
export type RlySheetSide = keyof typeof RLY_SHEET_VARIANTS.side

interface SheetRootBaseProps {
  readonly children: ReactNode
}

type ControlledSheetRootProps = SheetRootBaseProps & {
  readonly defaultOpen?: never
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}

type DefaultSheetRootProps = SheetRootBaseProps & {
  readonly defaultOpen?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly open?: never
}

/** Controlled-first or locally owned state for a sheet tree. */
export type SheetRootProps = ControlledSheetRootProps | DefaultSheetRootProps

/** Props for the visible native button that opens a sheet. */
export type SheetTriggerProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  /** Visible text that identifies the panel being opened. */
  readonly children: number | string
}

/** Props for a visible native button that closes a sheet. */
export type SheetCloseProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  /** Visible text that identifies the close action. */
  readonly children: number | string
}

/** Accessible content, naming, focus, and logical placement for a sheet surface. */
export type SheetContentProps = Omit<
  ComponentPropsWithRef<"div">,
  "aria-label" | "aria-labelledby" | "children" | "title"
> & {
  readonly children: ReactNode
  /** Accessible text for the built-in icon close action. */
  readonly closeLabel?: string
  /** Optional visible supporting description announced with the title. */
  readonly description?: string
  /** Optional target for deterministic initial focus. Content receives focus by default. */
  readonly initialFocusRef?: RefObject<HTMLElement | null>
  readonly side?: RlySheetSide
  /** Required visible heading and accessible name for the sheet. */
  readonly title: string
}

/** Props for the independently scrolling sheet body. */
export type SheetBodyProps = ComponentPropsWithRef<"div">
/** Props for the persistent sheet action footer. */
export type SheetFooterProps = ComponentPropsWithRef<"footer">

interface SheetState {
  readonly open: boolean
  readonly requestOpenChange: (open: boolean) => void
  readonly restoreFocusRef: RefObject<HTMLElement | null>
}

const SheetStateContext = createContext<SheetState | null>(null)

const useSheetState = (): SheetState => {
  const state = useContext(SheetStateContext)
  if (state === null) throw new Error("Sheet compound components must be nested inside Sheet.Root")
  return state
}

const SheetLayer = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const state = useSheetState()
  const layerRef = useRef<HTMLDivElement>(null)
  useModalIsolation(layerRef, state.open)
  return (
    <div className={style("layer")} data-rly-sheet-layer="" ref={layerRef}>
      {children}
    </div>
  )
}

const requireVisibleAction = (value: number | string, component: string): number | string => {
  if (typeof value === "string") requireText(value, `${component} children`)
  return value
}

const SheetRoot = (componentProps: SheetRootProps): ReactElement => {
  const { children, defaultOpen = false, onOpenChange, open } = componentProps
  const [defaultState, setDefaultState] = useState(defaultOpen)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const resolvedOpen = open ?? defaultState
  const previousOpenRef = useRef(resolvedOpen)
  const requestOpenChange = (nextOpen: boolean): void => {
    if (open === undefined) setDefaultState(nextOpen)
    onOpenChange?.(nextOpen)
  }

  useLayoutEffect(() => {
    if (previousOpenRef.current === resolvedOpen) return
    previousOpenRef.current = resolvedOpen
    if (resolvedOpen) invalidateModalFocusRestore()
    else restoreModalFocusAfterCleanup(restoreFocusRef.current)
  }, [resolvedOpen])

  return (
    <SheetStateContext.Provider value={{ open: resolvedOpen, requestOpenChange, restoreFocusRef }}>
      <RadixDialog.Root modal onOpenChange={requestOpenChange} open={resolvedOpen}>
        {children}
      </RadixDialog.Root>
    </SheetStateContext.Provider>
  )
}

const SheetTrigger = ({ children, className, onClick, type, ...props }: SheetTriggerProps): ReactElement => {
  const state = useSheetState()
  return (
    <RadixDialog.Trigger
      {...props}
      className={classNames(style("trigger"), className)}
      onClick={(event) => {
        state.restoreFocusRef.current = event.currentTarget
        onClick?.(event)
      }}
      type={type ?? "button"}
    >
      {requireVisibleAction(children, "Sheet.Trigger")}
    </RadixDialog.Trigger>
  )
}

const SheetClose = ({ children, className, type, ...props }: SheetCloseProps): ReactElement => (
  <RadixDialog.Close {...props} className={classNames(style("close"), className)} type={type ?? "button"}>
    {requireVisibleAction(children, "Sheet.Close")}
  </RadixDialog.Close>
)

const SheetBody = ({ className, ...props }: SheetBodyProps): ReactElement => (
  <div {...props} className={classNames(style("body"), className)} />
)

const SheetFooter = ({ className, ...props }: SheetFooterProps): ReactElement => (
  <footer {...props} className={classNames(style("footer"), className)} />
)

const SheetContent = ({
  children,
  className,
  closeLabel,
  description,
  initialFocusRef,
  ref,
  side = RLY_SHEET_DEFAULT_VARIANTS.side,
  tabIndex,
  title,
  ...props
}: SheetContentProps): ReactElement => {
  const state = useSheetState()
  const visibleTitle = requireText(title, "Sheet title")
  const visibleDescription = description === undefined ? undefined : requireText(description, "Sheet description")
  const accessibleCloseLabel = requireText(closeLabel ?? `Close ${visibleTitle}`, "Sheet closeLabel")
  const contentRef = useRef<HTMLDivElement | null>(null)
  const setContentRef = useCallback(
    (node: HTMLDivElement | null): void => {
      contentRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref !== null && ref !== undefined) ref.current = node
    },
    [ref]
  )

  return (
    <PortalBoundary>
      {(container) => (
        <RadixDialog.Portal container={container}>
          <SheetLayer>
            <RadixDialog.Overlay
              className={style("overlay")}
              data-rly-sheet-overlay=""
              onPointerDown={() => state.requestOpenChange(false)}
            />
            <RadixDialog.Content
              {...props}
              {...(visibleDescription === undefined ? { "aria-describedby": undefined } : {})}
              className={classNames(style("content"), RLY_SHEET_VARIANTS.side[side].className, className)}
              data-rly-sheet-side={side}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                const activeElement = contentRef.current?.ownerDocument.activeElement ?? null
                if (state.restoreFocusRef.current === null && isHTMLElement(activeElement)) {
                  state.restoreFocusRef.current = activeElement
                }
                const target = initialFocusRef?.current ?? contentRef.current
                target?.focus()
                if (target !== contentRef.current && target?.ownerDocument.activeElement !== target)
                  contentRef.current?.focus()
              }}
              ref={setContentRef}
              tabIndex={tabIndex ?? -1}
            >
              <div className={style("header")}>
                <div className={style("heading")}>
                  <RadixDialog.Title className={style("title")}>{visibleTitle}</RadixDialog.Title>
                  {visibleDescription === undefined ? null : (
                    <RadixDialog.Description className={style("description")}>
                      {visibleDescription}
                    </RadixDialog.Description>
                  )}
                </div>
                <RadixDialog.Close aria-label={accessibleCloseLabel} className={style("iconClose")} type="button">
                  <Icon decorative name="close" size="default" />
                </RadixDialog.Close>
              </div>
              {children}
            </RadixDialog.Content>
          </SheetLayer>
        </RadixDialog.Portal>
      )}
    </PortalBoundary>
  )
}

/** Owned compound side panel with modal focus, dismissal, and portal behavior. */
export const Sheet = Object.freeze({
  Body: SheetBody,
  Close: SheetClose,
  Content: SheetContent,
  Footer: SheetFooter,
  Root: SheetRoot,
  Trigger: SheetTrigger
})

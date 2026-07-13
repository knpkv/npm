import {
  type ComponentPropsWithRef,
  createContext,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import { Dialog as RadixDialog } from "radix-ui"
import { PortalBoundary } from "../foundations/PortalProvider.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import {
  invalidateModalFocusRestore,
  isHTMLElement,
  ModalNestingBoundary,
  restoreModalFocusAfterCleanup,
  useModalContentRegistration,
  useModalIsolation,
  useParentModalReady
} from "../internal/modal.js"
import { Button, type ButtonProps } from "./Button.js"
import styles from "./Dialog.module.css"

const style = (name: string): string => cssClass(styles, name)

interface DialogState {
  readonly open: boolean
  readonly requestOpenChange: (open: boolean) => void
  readonly restoreTargetRef: RefObject<HTMLElement | null>
  readonly triggerRef: RefObject<HTMLButtonElement | null>
}

const DialogStateContext = createContext<DialogState | null>(null)

const useDialogState = (): DialogState => {
  const state = useContext(DialogStateContext)
  if (state === null) throw new Error("Dialog compound components must be nested inside Dialog")
  return state
}

const assignRef = <Element,>(ref: Ref<Element> | undefined, value: Element | null): void => {
  if (typeof ref === "function") ref(value)
  else if (ref !== null && ref !== undefined) ref.current = value
}

const getActiveElement = (): HTMLElement | null =>
  typeof document === "undefined" || !isHTMLElement(document.activeElement) ? null : document.activeElement

/** Semantic size metadata for the dialog surface. */
export const RLY_DIALOG_VARIANTS = defineVariants({
  size: {
    default: {
      className: style("defaultSize"),
      purpose: "Focused decision or short form",
      tokens: ["radius-overlay", "space-32"]
    },
    wide: {
      className: style("wide"),
      purpose: "Detailed comparison or multi-section form",
      tokens: ["radius-overlay", "space-64"]
    }
  }
})

/** Default dialog size used when no size is selected. */
export const RLY_DIALOG_DEFAULT_VARIANTS = defineVariants({ size: "default" })
/** Available dialog surface sizes. */
export type RlyDialogSize = keyof typeof RLY_DIALOG_VARIANTS.size

type DialogBaseProps = { readonly children: ReactNode }
type ControlledDialogProps = DialogBaseProps & {
  readonly defaultOpen?: never
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}
type DefaultDialogProps = DialogBaseProps & {
  readonly defaultOpen?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly open?: never
}
/** Controlled-first or locally owned state for a dialog tree. */
export type DialogRootProps = ControlledDialogProps | DefaultDialogProps

/** Props for the visible rly button that opens a dialog. */
export type DialogTriggerProps = ButtonProps
/** Props for a visible rly button that closes a dialog. */
export type DialogCloseProps = ButtonProps

/** Accessible content, naming, focus, and sizing for a modal dialog surface. */
export type DialogContentProps = Omit<
  ComponentPropsWithRef<"div">,
  "aria-describedby" | "aria-label" | "aria-labelledby" | "children" | "title"
> & {
  readonly children: ReactNode
  readonly description?: string
  readonly initialFocusRef?: RefObject<HTMLElement | null>
  readonly size?: RlyDialogSize
  readonly title: string
}

const DialogLayer = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const state = useDialogState()
  const ref = useRef<HTMLDivElement>(null)
  useModalContentRegistration()
  useModalIsolation(ref, state.open)
  return (
    <div className={style("layer")} data-rly-dialog-layer="" data-rly-modal-layer="" ref={ref}>
      {children}
    </div>
  )
}

/** Own controlled or reusable default dialog state without exposing Radix contracts. */
const DialogRoot = ({ children, defaultOpen = false, onOpenChange, open }: DialogRootProps): ReactElement => {
  const [defaultState, setDefaultState] = useState(defaultOpen)
  const isParentModalReady = useParentModalReady()
  const resolvedOpen = (open ?? defaultState) && isParentModalReady
  const previousOpenRef = useRef(resolvedOpen)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const restoreTargetRef = useRef<HTMLElement | null>(resolvedOpen ? getActiveElement() : null)
  if (resolvedOpen && !previousOpenRef.current) {
    restoreTargetRef.current = triggerRef.current ?? getActiveElement()
  }
  const requestOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) restoreTargetRef.current = triggerRef.current ?? getActiveElement()
    if (open === undefined) setDefaultState(nextOpen)
    onOpenChange?.(nextOpen)
  }

  useLayoutEffect(() => {
    if (previousOpenRef.current === resolvedOpen) return
    previousOpenRef.current = resolvedOpen
    if (resolvedOpen) invalidateModalFocusRestore()
    else restoreModalFocusAfterCleanup(restoreTargetRef.current)
  }, [resolvedOpen])

  return (
    <ModalNestingBoundary>
      <DialogStateContext.Provider value={{ open: resolvedOpen, requestOpenChange, restoreTargetRef, triggerRef }}>
        <RadixDialog.Root modal onOpenChange={requestOpenChange} open={resolvedOpen}>
          {children}
        </RadixDialog.Root>
      </DialogStateContext.Provider>
    </ModalNestingBoundary>
  )
}

/** Render the explicit action that opens a dialog using rly Button semantics. */
const DialogTrigger = ({ ref, ...props }: DialogTriggerProps): ReactElement => {
  const state = useDialogState()
  return (
    <RadixDialog.Trigger asChild>
      <Button
        {...props}
        ref={(element) => {
          state.triggerRef.current = element
          assignRef(ref, element)
        }}
      />
    </RadixDialog.Trigger>
  )
}

/** Render the explicit action that closes the current dialog. */
const DialogClose = (props: DialogCloseProps): ReactElement => (
  <RadixDialog.Close asChild>
    <Button {...props} />
  </RadixDialog.Close>
)

/** Render a named modal surface in the application-controlled portal boundary. */
const DialogContent = ({
  children,
  className,
  description,
  initialFocusRef,
  size = "default",
  title,
  ...props
}: DialogContentProps): ReactElement => {
  const state = useDialogState()
  const visibleTitle = requireText(title, "Dialog title")
  const visibleDescription = description === undefined ? undefined : requireText(description, "Dialog description")

  return (
    <PortalBoundary>
      {(container) => (
        <RadixDialog.Portal container={container}>
          <DialogLayer>
            <RadixDialog.Overlay
              className={style("overlay")}
              data-rly-dialog-overlay=""
              onPointerDown={() => {
                state.requestOpenChange(false)
              }}
            />
            <RadixDialog.Content
              {...props}
              {...(visibleDescription === undefined ? { "aria-describedby": undefined } : {})}
              className={classNames(style("content"), RLY_DIALOG_VARIANTS.size[size].className, className)}
              onCloseAutoFocus={(event) => {
                event.preventDefault()
              }}
              onOpenAutoFocus={(event) => {
                const activeElement = getActiveElement()
                if (state.triggerRef.current === null && activeElement !== null) {
                  state.restoreTargetRef.current = activeElement
                }
                const target = initialFocusRef?.current
                if (target !== null && target !== undefined) {
                  event.preventDefault()
                  target.focus()
                }
              }}
            >
              <header className={style("header")}>
                <RadixDialog.Title className={style("title")}>{visibleTitle}</RadixDialog.Title>
                {visibleDescription === undefined ? null : (
                  <RadixDialog.Description className={style("description")}>
                    {visibleDescription}
                  </RadixDialog.Description>
                )}
              </header>
              <div className={style("body")}>{children}</div>
            </RadixDialog.Content>
          </DialogLayer>
        </RadixDialog.Portal>
      )}
    </PortalBoundary>
  )
}

/** Owned compound dialog API with no Radix types or slots in its public contract. */
export const Dialog = Object.freeze({
  Close: DialogClose,
  Content: DialogContent,
  Root: DialogRoot,
  Trigger: DialogTrigger
})

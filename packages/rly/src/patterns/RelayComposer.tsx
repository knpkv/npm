import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode, Ref } from "react"
import { useCallback, useId, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { cssClass, requireText } from "../internal/component.js"
import * as Predicate from "../internal/predicates.js"
import { isImeKey } from "../internal/relaySummon.js"
import { Button } from "../primitives/Button.js"
import { IconButton } from "../primitives/IconButton.js"
import styles from "./RelayComposer.module.css"
import { useRelayShortcut } from "./RelayLauncher.js"

const style = (name: string): string => cssClass(styles, name)

/** Something the message is about, shown as a removable chip ("patch-reader.ts lines 14 to 19"). */
export interface RlyRelayContextRef {
  readonly id: string
  readonly label: string
}

/** One accepted-message request: the text and the client request id a retry must reuse. */
export interface RlyRelaySubmission {
  readonly requestId: string
  readonly text: string
}

/** Inputs for the composer. */
export interface RelayComposerProps {
  /** Why Send is unavailable (a run in flight); shown, and announced with Send. */
  readonly busyReason?: string | undefined
  readonly contextRefs?: ReadonlyArray<RlyRelayContextRef>
  /** The textarea's name, "Message Relay" unless the host names it. */
  readonly label?: string
  readonly onRemoveContextRef?: (id: string) => void
  /** Called with Ctrl/⌘+Enter or Send when there is text and nothing blocks it. */
  readonly onSend: () => void
  /** Stop the run; pass it only while a run is in flight and the session offers cancel. */
  readonly onStop?: (() => void) | undefined
  readonly onValueChange: (value: string) => void
  readonly placeholder?: string
  /** One run preset control, usually a menu trigger ("Thorough review, Codex"). */
  readonly preset?: ReactNode
  /** The textarea, for useRelaySummon's composerRef. */
  readonly ref?: Ref<HTMLTextAreaElement>
  readonly value: string
}

const assignRef = <T,>(ref: Ref<T> | undefined, value: T | null): void => {
  if (Predicate.isFunction(ref)) ref(value)
  else if (ref !== undefined && ref !== null) ref.current = value
}

/**
 * Relay's message box (Relay UX decision). It grows with its text up to min(12 lines, 40% of the
 * viewport), then scrolls. Enter is a newline and Ctrl/⌘+Enter sends, said as visible text beside Send;
 * an IME composition never sends. While `busyReason` is set, Send stays focusable (aria-disabled) so
 * its reason is heard, and pressing it does nothing. Keep the value with `useRelayDraft`, keyed by the
 * object Relay is about, so it survives closing, reopening and resizing.
 */
export const RelayComposer = ({
  busyReason,
  contextRefs = [],
  label = "Message Relay",
  onRemoveContextRef,
  onSend,
  onStop,
  onValueChange,
  placeholder,
  preset,
  ref,
  value
}: RelayComposerProps): ReactElement => {
  const hintId = useId()
  const busyId = useId()
  const input = useRef<HTMLTextAreaElement | null>(null)
  const apple = useRelayShortcut().keys.startsWith("Meta")
  const blocked = busyReason !== undefined || value.trim() === ""
  const setInput = useCallback(
    (element: HTMLTextAreaElement | null) => {
      input.current = element
      assignRef(ref, element)
    },
    [ref]
  )

  // Grow with the text in every browser (field-sizing is not everywhere); CSS caps the height.
  useLayoutEffect(() => {
    const element = input.current
    if (element === null) return
    element.style.blockSize = "auto"
    element.style.blockSize = `${element.scrollHeight}px`
  }, [value])

  const send = (): void => {
    if (!blocked) onSend()
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || isImeKey(event.nativeEvent)) return
    if (!(apple ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return
    event.preventDefault()
    send()
  }

  return (
    <div className={style("root")}>
      {contextRefs.length === 0 ? null : (
        <ul aria-label="Asking with" className={style("refs")}>
          {contextRefs.map((contextRef) => (
            <li className={style("ref")} key={contextRef.id}>
              <span className={style("refLabel")}>{requireText(contextRef.label, "RelayComposer context label")}</span>
              {onRemoveContextRef === undefined ? null : (
                <IconButton
                  icon="close"
                  label={`Remove ${contextRef.label}`}
                  onClick={() => onRemoveContextRef(contextRef.id)}
                  variant="quiet"
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className={style("box")}>
        <textarea
          aria-describedby={hintId}
          aria-label={requireText(label, "RelayComposer label")}
          className={style("input")}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onValueChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          ref={setInput}
          rows={1}
          value={value}
        />
        <div className={style("foot")}>
          {preset}
          <span className={style("hint")} id={hintId}>
            {apple ? "⌘ Enter to send" : "Ctrl Enter to send"}
          </span>
          {busyReason === undefined ? null : (
            <span className={style("busy")} id={busyId}>
              {requireText(busyReason, "RelayComposer busy reason")}
            </span>
          )}
          {onStop === undefined ? null : (
            <Button onClick={onStop} type="button">
              Stop
            </Button>
          )}
          <Button
            aria-describedby={busyReason === undefined ? undefined : busyId}
            aria-disabled={blocked}
            onClick={send}
            type="button"
            variant="primary"
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

/** A per-object draft: the value for the composer and the submission a send makes. */
export interface RlyRelayDraft {
  /** The request was accepted: clear the draft and its request id. */
  readonly accepted: () => void
  readonly onValueChange: (value: string) => void
  /** The current text with a request id that stays the same until the text changes or is accepted. */
  readonly submission: () => RlyRelaySubmission
  readonly value: string
}

/** Storage a draft may survive a reload in; session storage, never local storage (drafts may be sensitive). */
export type RlyRelayDraftStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">

/** Inputs for {@link useRelayDraft}. */
export interface UseRelayDraftOptions {
  /** Mints a client request id (the host's own, e.g. a UUID from its runtime); rly owns no id source. */
  readonly newRequestId: () => string
  /** Opt in to surviving a reload; read lazily, and any refusal keeps the draft in memory only. */
  readonly storage?: () => RlyRelayDraftStorage
}

interface DraftEntry {
  readonly requestId: string | null
  readonly text: string
}

const drafts = new Map<string, DraftEntry>()
const listeners = new Map<string, Set<() => void>>()
const emptyDraft: DraftEntry = { requestId: null, text: "" }
/** Long drafts beyond this stay in memory only, so storage never fills. */
const STORED_DRAFT_LIMIT = 50_000
const storageKey = (objectKey: string): string => `rly.relay.draft:${objectKey}`

const notify = (objectKey: string): void => {
  for (const listener of listeners.get(objectKey) ?? []) listener()
}

const readStored = (objectKey: string, storage: (() => RlyRelayDraftStorage) | undefined): DraftEntry => {
  if (storage === undefined) return emptyDraft
  try {
    const text = storage().getItem(storageKey(objectKey))
    return text === null ? emptyDraft : { requestId: null, text }
  } catch {
    // best-effort: storage refused (private mode, blocked site data); the draft lives in memory only.
    return emptyDraft
  }
}

const writeStored = (objectKey: string, text: string, storage: (() => RlyRelayDraftStorage) | undefined): void => {
  if (storage === undefined) return
  try {
    if (text === "" || text.length > STORED_DRAFT_LIMIT) storage().removeItem(storageKey(objectKey))
    else storage().setItem(storageKey(objectKey), text)
  } catch {
    // best-effort: storage refused or full; the in-memory draft is still current.
  }
}

/**
 * The composer's draft for one object (the JSON ObjectRef, so PR A's draft can never send as PR B's).
 * It lives in memory for the page, so closing, reopening or resizing Relay keeps it; with `storage`
 * (session storage) it also survives a reload. A send reuses one request id until the text is edited,
 * so a retry after an uncertain outcome is deduplicated and an edited message is a new one.
 */
export const useRelayDraft = (objectKey: string, options: UseRelayDraftOptions): RlyRelayDraft => {
  const { newRequestId, storage } = options
  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = listeners.get(objectKey) ?? new Set()
      set.add(onChange)
      listeners.set(objectKey, set)
      return () => set.delete(onChange)
    },
    [objectKey]
  )
  const read = useCallback((): DraftEntry => {
    const known = drafts.get(objectKey)
    if (known !== undefined) return known
    const stored = readStored(objectKey, storage)
    drafts.set(objectKey, stored)
    return stored
  }, [objectKey, storage])
  const entry = useSyncExternalStore(subscribe, read, () => emptyDraft)

  const onValueChange = useCallback(
    (text: string) => {
      const current = drafts.get(objectKey) ?? emptyDraft
      drafts.set(objectKey, { requestId: text === current.text ? current.requestId : null, text })
      writeStored(objectKey, text, storage)
      notify(objectKey)
    },
    [objectKey, storage]
  )
  const submission = useCallback((): RlyRelaySubmission => {
    const current = drafts.get(objectKey) ?? emptyDraft
    const requestId = current.requestId ?? newRequestId()
    drafts.set(objectKey, { requestId, text: current.text })
    return { requestId, text: current.text }
  }, [newRequestId, objectKey])
  const accepted = useCallback(() => {
    drafts.set(objectKey, emptyDraft)
    writeStored(objectKey, "", storage)
    notify(objectKey)
  }, [objectKey, storage])

  return { accepted, onValueChange, submission, value: entry.text }
}

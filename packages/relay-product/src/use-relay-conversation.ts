/**
 * A component's view of one Relay conversation, from the page's shared {@link RelayConversations}.
 *
 * @module
 */
import { type ObjectRef, objectRefKey } from "@knpkv/relay/wire"
import { useCallback, useMemo, useSyncExternalStore } from "react"

import type { RelayConversations } from "./relay-conversations.js"
import type { RelayConversationState } from "./relay-fold.js"

/**
 * The conversation's current state, re-rendering on each event. Reading it keeps the conversation's stream
 * open; the stream closes when the last reader unmounts.
 */
export const useRelayConversation = (
  conversations: RelayConversations,
  ref: ObjectRef
): RelayConversationState => {
  const key = objectRefKey(ref)
  // The ref's identity changes on every render; its key is what names the conversation.
  const stableRef = useMemo(() => ref, [key])
  const subscribe = useCallback(
    (onChange: () => void) => conversations.subscribe(stableRef, () => onChange()),
    [conversations, stableRef]
  )
  const read = useCallback(() => conversations.get(stableRef), [conversations, stableRef])
  return useSyncExternalStore(subscribe, read, read)
}

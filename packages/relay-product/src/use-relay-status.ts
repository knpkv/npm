/**
 * Relay's mark and status words for one conversation, for a surface that shows them (a header mark, a
 * panel head, a dock).
 *
 * @module
 */
import type { ObjectRef } from "@knpkv/relay/wire"
import { useEffect, useState } from "react"

import type { RelayConversations } from "./relay-conversations.js"
import {
  nextSeenReplies,
  type RelaySeenReplies,
  relaySeenRepliesUnknown,
  relayStatusOf,
  type RelayStatusView
} from "./relay-status.js"
import { useRelayConversation } from "./use-relay-conversation.js"

/**
 * The conversation's status, re-rendering on each event. `panelOpen` is whether the reader can see the
 * conversation now: a reply that finishes while it is false shows as unread until it is true again.
 */
export const useRelayStatus = (
  conversations: RelayConversations,
  ref: ObjectRef,
  panelOpen: boolean
): RelayStatusView => {
  const state = useRelayConversation(conversations, ref)
  const [seen, setSeen] = useState<RelaySeenReplies>(relaySeenRepliesUnknown)
  const next = nextSeenReplies(seen, state, panelOpen)
  useEffect(() => {
    if (next !== seen) setSeen(next)
  }, [next, seen])
  return relayStatusOf(state, { panelOpen, seen: next })
}

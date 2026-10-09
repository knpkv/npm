/**
 * `@knpkv/relay-product/client`: one Relay conversation in the browser, over any product's `/…/relay` routes.
 * Needs `@knpkv/relay` (for its browser-safe `wire` entry) beside it.
 *
 * @module
 */
export {
  makeRelayClient,
  type RelayClient,
  type RelayClientOptions,
  type RelayRequestFailure,
  RelayTransportFailed,
  RelayUnauthorized
} from "./relay-client.js"
export {
  makeRelayConversations,
  type RelayConversationListener,
  type RelayConversations,
  type RelayOutgoingMessage,
  type RelayRuntime,
  SendIdUnavailable
} from "./relay-conversations.js"
export {
  foldRelayConversation,
  initialRelayConversation,
  type RelayClientEvent,
  type RelayConfirmationCard,
  type RelayConnection,
  type RelayConversationState,
  type RelayQueuedMessage,
  type RelayToolRow,
  type RelayTranscriptMessage
} from "./relay-fold.js"
export {
  finishedReplies,
  nextSeenReplies,
  RELAY_STATUS_LINE_MAX,
  type RelaySeenReplies,
  relaySeenRepliesUnknown,
  relayStatusOf,
  type RelayStatusView
} from "./relay-status.js"
export { useRelayConversation } from "./use-relay-conversation.js"
export { useRelayStatus } from "./use-relay-status.js"

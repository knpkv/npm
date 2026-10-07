import { TerminalScrollState } from "@knpkv/herdr-connect"
import { Option, Schema } from "effect"
import type { RawData } from "ws"

const decodeScrollState = Schema.decodeUnknownOption(Schema.fromJsonString(TerminalScrollState))

/**
 * Whether a message relayed from a remote host is a scroll state. Those carry only the newest
 * value, so under browser backpressure they wait instead of closing the terminal like a frame would.
 */
export const isRelayedScrollState = (data: RawData, isBinary: boolean): boolean =>
  !isBinary && Option.isSome(decodeScrollState(rawText(data)))

/** The text of a WebSocket message, however `ws` delivered it. */
export const rawText = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString()
    : Buffer.isBuffer(data)
    ? data.toString()
    : Buffer.from(data).toString()

export const relayTerminalCloseCode = (code: number): number =>
  (code >= 1_000 &&
      code <= 1_014 &&
      code !== 1_004 &&
      code !== 1_005 &&
      code !== 1_006) ||
    (code >= 3_000 && code <= 4_999)
    ? code
    : 4_503

export const terminalBufferLimitBytes = 1024 * 1024

export const terminalBufferCanAccept = (
  bufferedBytes: number,
  payloadBytes: number
): boolean =>
  bufferedBytes === 0 ||
  bufferedBytes + payloadBytes <= terminalBufferLimitBytes

/** The parts of a socket a newest-value signal needs. */
export interface SignalSocket {
  readonly bufferedAmount: () => number
  readonly isOpen: () => boolean
  readonly send: (payload: string) => void
}

export interface LatestSignalSender {
  readonly offer: (payload: string) => void
  readonly dispose: () => void
}

/**
 * Sends a signal where only the newest value matters, such as a pane's scroll position. Under
 * backpressure it holds the newest payload and retries every `retryMs` until the buffer accepts it;
 * a newer offer replaces a held one. Dropping instead would lose the value for good, because
 * producers report only changes. Call `dispose` when the socket closes.
 */
export const makeLatestSignalSender = (socket: SignalSocket, retryMs: number): LatestSignalSender => {
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    if (pending === null || !socket.isOpen()) {
      pending = null
      return
    }
    if (terminalBufferCanAccept(socket.bufferedAmount(), Buffer.byteLength(pending))) {
      const payload = pending
      pending = null
      socket.send(payload)
      return
    }
    timer = setTimeout(flush, retryMs)
  }
  return {
    offer: (payload) => {
      pending = payload
      if (timer === null) flush()
    },
    dispose: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = null
    }
  }
}

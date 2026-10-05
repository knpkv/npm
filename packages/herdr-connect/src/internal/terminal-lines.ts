/**
 * Splits the Herdr attach client's stdout into lines, each capped at
 * {@link terminalEventMaxLineBytes}.
 *
 * This caps each line, not the stream's running total, so it is not a
 * `@knpkv/bounded-io` budget: a long session may emit any number of lines.
 * The buffer grows geometrically and is reused, keeping copies linear.
 *
 * @internal
 */
import { Effect, Stream } from "effect"
import { TerminalProtocolError } from "../errors.js"

export const terminalEventMaxLineBytes = 4 * 1024 * 1024 + 4 * 1024

interface TerminalLineState {
  readonly buffer: Uint8Array
  readonly length: number
}

const terminalLineInitialBytes = 64 * 1_024

const emptyTerminalLine = (): TerminalLineState => ({
  buffer: new Uint8Array(terminalLineInitialBytes),
  length: 0
})

const decodeTerminalLine = (bytes: Uint8Array): string => {
  const content = bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes
  return new TextDecoder().decode(content)
}

const growTerminalLineBuffer = (
  buffer: Uint8Array,
  requiredBytes: number,
  onBufferCopy: ((bytes: number) => void) | undefined
): Uint8Array => {
  if (requiredBytes <= buffer.byteLength) return buffer
  let capacity = buffer.byteLength
  while (capacity < requiredBytes) {
    capacity = Math.min(capacity * 2, terminalEventMaxLineBytes)
  }
  const grown = new Uint8Array(capacity)
  onBufferCopy?.(buffer.byteLength)
  grown.set(buffer)
  return grown
}

/** @internal Exposes copied-byte accounting only for the deterministic complexity regression. */
export const boundedTerminalLines = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  onBufferCopy?: (bytes: number) => void
) =>
  stream.pipe(
    Stream.mapAccumEffect(
      emptyTerminalLine,
      (state, chunk) => {
        let buffer = state.buffer
        let length = state.length
        const lines: Array<string> = []
        let offset = 0
        while (offset < chunk.byteLength) {
          const newline = chunk.indexOf(10, offset)
          const end = newline === -1 ? chunk.byteLength : newline
          const nextLength = length + end - offset
          if (nextLength > terminalEventMaxLineBytes) {
            return Effect.fail(
              new TerminalProtocolError({
                cause: nextLength,
                detail: `Herdr terminal event exceeded ${terminalEventMaxLineBytes} bytes`
              })
            )
          }
          buffer = growTerminalLineBuffer(buffer, nextLength, onBufferCopy)
          buffer.set(chunk.subarray(offset, end), length)
          length = nextLength
          if (newline === -1) break
          lines.push(decodeTerminalLine(buffer.subarray(0, length)))
          length = 0
          offset = newline + 1
        }
        const result: readonly [TerminalLineState, ReadonlyArray<string>] = [
          { buffer, length },
          lines
        ]
        return Effect.succeed(result)
      },
      {
        onHalt: (state) =>
          state.length === 0
            ? []
            : [decodeTerminalLine(state.buffer.subarray(0, state.length))]
      }
    )
  )

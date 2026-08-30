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
): boolean => bufferedBytes + payloadBytes <= terminalBufferLimitBytes

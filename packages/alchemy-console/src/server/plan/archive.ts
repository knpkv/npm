/** Node compression adapter. Inspects one regular plan.json member in memory, without filesystem extraction. */
import { Effect, Schema } from "effect"
import { crc32, inflateRawSync } from "node:zlib"

export const archiveLimit = 1_000_000
export class PlanArchiveInvalid extends Schema.TaggedError<PlanArchiveInvalid>()("PlanArchiveInvalid", {}) {}

const requireArchive = (condition: boolean): void => {
  if (!condition) throw new PlanArchiveInvalid({})
}

/** Both ZIP metadata and actual expanded bytes must fit the cap. Local and central identities must agree. */
export const archiveText = (bytes: Uint8Array) =>
  Effect.try({
    try: () => {
      requireArchive(bytes.length > 0 && bytes.length < archiveLimit)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const u16 = (offset: number) => view.getUint16(offset, true)
      const u32 = (offset: number) => view.getUint32(offset, true)
      let end = bytes.length - 22
      while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--
      requireArchive(end >= 0 && end + 22 + u16(end + 20) === bytes.length)
      requireArchive(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === 1 && u16(end + 10) === 1)
      const directory = u32(end + 16)
      requireArchive(directory + u32(end + 12) === end && u32(directory) === 0x02014b50)
      const flags = u16(directory + 8)
      const method = u16(directory + 10)
      const checksum = u32(directory + 16)
      const compressed = u32(directory + 20)
      const expanded = u32(directory + 24)
      const nameLength = u16(directory + 28)
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(directory + 46, directory + 46 + nameLength)
      )
      const mode = u32(directory + 38) >>> 16
      requireArchive(name === "plan.json" && nameLength === 9 && u16(directory + 34) === 0)
      requireArchive((mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000)
      requireArchive((flags & ~0x808) === 0 && (method === 0 || method === 8))
      requireArchive(expanded > 0 && expanded < archiveLimit && compressed > 0 && compressed < archiveLimit)
      requireArchive(directory + 46 + nameLength + u16(directory + 30) + u16(directory + 32) === end)
      const local = u32(directory + 42)
      requireArchive(local === 0 && u32(local) === 0x04034b50)
      requireArchive(u16(local + 6) === flags && u16(local + 8) === method && u16(local + 26) === nameLength)
      const localName = bytes.subarray(local + 30, local + 30 + nameLength)
      requireArchive(new TextDecoder("utf-8", { fatal: true }).decode(localName) === name)
      const start = local + 30 + nameLength + u16(local + 28)
      const dataEnd = start + compressed
      if ((flags & 8) === 0) {
        requireArchive(
          u32(local + 14) === checksum && u32(local + 18) === compressed && u32(local + 22) === expanded &&
            dataEnd === directory
        )
      } else {
        const descriptor = u32(dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd
        requireArchive(
          descriptor + 12 === directory && u32(descriptor) === checksum && u32(descriptor + 4) === compressed &&
            u32(descriptor + 8) === expanded
        )
      }
      requireArchive(start < dataEnd && dataEnd <= directory)
      const data = bytes.subarray(start, dataEnd)
      const text = method === 0 ? data : inflateRawSync(data, { maxOutputLength: archiveLimit - 1 })
      requireArchive(text.length === expanded && crc32(text) === checksum)
      return new TextDecoder("utf-8", { fatal: true }).decode(text)
    },
    catch: () => new PlanArchiveInvalid({})
  })

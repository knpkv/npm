import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { lockfileJsonText } from "../src/internal/lockfile-json.js"

const Json = Schema.fromJsonString(Schema.Json)
const decode = (text: string) => Schema.decodeUnknownSync(Json)(lockfileJsonText(text))

describe("Bun text lockfile JSON", () => {
  it("accepts trailing commas in objects and arrays, as bun.lock writes them", () => {
    expect(decode("{ \"packages\": { \"alchemy\": [\"alchemy@0.62.0\", \"\", {},], }, }")).toEqual({
      packages: { alchemy: ["alchemy@0.62.0", "", {}] }
    })
  })

  it("leaves commas, brackets and comment markers inside strings alone", () => {
    expect(decode("{ \"a\": \"x, }\", \"b\": \"// not a comment\", \"c\": \"q\\\",]\", }")).toEqual({
      a: "x, }",
      b: "// not a comment",
      c: "q\",]"
    })
  })

  it("skips line and block comments", () => {
    expect(decode("// head\n{ /* inline */ \"a\": 1, // tail\n}")).toEqual({ a: 1 })
  })

  it("leaves text that isn't JSON for the decode to reject", () => {
    expect(() => decode("{ a: 1 }")).toThrow()
    expect(() => decode("{ \"a\": 1 ")).toThrow()
    expect(() => decode("{ \"a\": \"unterminated }")).toThrow()
    expect(() => decode("{ /* unterminated }")).toThrow()
  })

  it("stays linear on a lockfile-sized input", () => {
    const entries = Array.from({ length: 50_000 }, (_, index) => `"p${index}": ["p${index}@1.0.0", "", {},],`).join(
      "\n"
    )
    const started = performance.now()
    const Lock = Schema.fromJsonString(Schema.Struct({ packages: Schema.Record(Schema.String, Schema.Json) }))
    const lock = Schema.decodeUnknownSync(Lock)(lockfileJsonText(`{ "packages": { ${entries} }, }`))
    expect(Object.keys(lock.packages)).toHaveLength(50_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

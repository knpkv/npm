/**
 * Runs the Lua specs for the nvim statusline plugin as part of the normal gate.
 *
 * `nvim/lua/jcf/state.lua` ships inside this package (`files` includes `nvim`),
 * but it is Lua, so vitest cannot reach it directly. The specs stub job control
 * and time and run under `nvim --headless -l`, which is the only interpreter
 * this repo already depends on — see `nvim/test/state_spec.lua`.
 *
 * Skipping when `nvim` is absent is a local-dev convenience only. In CI the
 * check job installs neovim, and this suite is the only automated cover for the
 * plugin's single-flight and cache invariants — so a missing binary there is a
 * silent hole in the gate, and it fails instead of skipping.
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const specPath = fileURLToPath(new URL("../nvim/test/state_spec.lua", import.meta.url))

const hasNvim = spawnSync("nvim", ["--version"], { encoding: "utf8" }).status === 0
const isCi = process.env.CI !== undefined && process.env.CI !== "false"

describe("jcf nvim state plugin", () => {
  it.skipIf(!hasNvim && !isCi)("passes its Lua specs under headless nvim", () => {
    expect(hasNvim, "CI must provide neovim so these specs cannot silently skip").toBe(true)

    // `--clean` so the developer's own init.lua cannot affect the run or add
    // output of its own. The timeout matters because the specs drive a fake
    // clock: a regression that leaves the module waiting on something real
    // would hang nvim indefinitely, and without a bound that becomes a hung
    // vitest worker rather than a failed test.
    const result = spawnSync("nvim", ["--clean", "--headless", "-l", specPath], {
      encoding: "utf8",
      timeout: 60_000
    })
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`

    expect(result.signal, `nvim did not exit on its own: ${output}`).toBeNull()

    // The spec prints its own failure list; surface it verbatim so a failure
    // here is diagnosable without re-running nvim by hand. Matched loosely —
    // the exit code is the verdict, and anything else nvim emits is noise.
    expect(output).toContain("checks passed")
    expect(result.status, output).toBe(0)
  })
})

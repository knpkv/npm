import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Path } from "effect"

import {
  chooseControlCenterDataRoot,
  ControlCenterHomeUnset,
  legacyDataRootCandidate,
  legacyDataRootNotice
} from "../../src/server/dataRootDefault.js"

const unset = {
  configured: Option.none<string>(),
  xdgDataHome: Option.none<string>(),
  home: Option.some("/home/owner")
}

describe("Control Center default data root", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("uses CONTROL_CENTER_DATA_ROOT exactly as given, whatever else is set", () =>
      Effect.gen(function*() {
        const choice = yield* chooseControlCenterDataRoot({
          configured: Option.some("relative/root"),
          xdgDataHome: Option.some("/xdg/data"),
          home: Option.none()
        })
        assert.deepStrictEqual(choice, { _tag: "Configured", dataRoot: "relative/root" })
      }))

    it.effect("defaults to $XDG_DATA_HOME/control-center, then ~/.local/share/control-center", () =>
      Effect.gen(function*() {
        assert.deepStrictEqual(
          yield* chooseControlCenterDataRoot({ ...unset, xdgDataHome: Option.some("/xdg/data") }),
          { _tag: "Default", dataRoot: "/xdg/data/control-center" }
        )
        assert.deepStrictEqual(yield* chooseControlCenterDataRoot(unset), {
          _tag: "Default",
          dataRoot: "/home/owner/.local/share/control-center"
        })
      }))

    // The XDG base directory spec says a relative or empty value is invalid and must be ignored.
    it.effect("ignores a relative or empty XDG_DATA_HOME", () =>
      Effect.gen(function*() {
        for (const xdgDataHome of ["", "relative/data"]) {
          assert.deepStrictEqual(
            yield* chooseControlCenterDataRoot({ ...unset, xdgDataHome: Option.some(xdgDataHome) }),
            { _tag: "Default", dataRoot: "/home/owner/.local/share/control-center" },
            xdgDataHome
          )
        }
      }))

    it.effect("fails by name when no override is set and HOME is unset or relative", () =>
      Effect.gen(function*() {
        for (const home of [Option.none<string>(), Option.some(""), Option.some("relative")]) {
          const error = yield* chooseControlCenterDataRoot({ ...unset, home }).pipe(Effect.flip)
          assert.instanceOf(error, ControlCenterHomeUnset)
        }
      }))

    // Before this default, the data root was `.control-center` in whatever directory the CLI ran from.
    it.effect("names the old working-directory root only when the default is in use", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const legacy = path.resolve(".control-center")
        assert.deepStrictEqual(
          yield* legacyDataRootCandidate({ _tag: "Default", dataRoot: "/home/owner/.local/share/control-center" }),
          Option.some(legacy)
        )
        assert.deepStrictEqual(
          yield* legacyDataRootCandidate({ _tag: "Configured", dataRoot: ".control-center" }),
          Option.none()
        )
        // A default that already is the old location (HOME is the working directory's parent) is not old.
        assert.deepStrictEqual(yield* legacyDataRootCandidate({ _tag: "Default", dataRoot: legacy }), Option.none())
      }))
  })

  // A plain `mv` would break the root: it is a claim bound to its basename. The notice offers the two moves
  // that keep it valid, and never moves anything itself.
  it("tells the owner where the old root is and how to keep or move it", () => {
    const notice = legacyDataRootNotice({
      legacyRoot: "/work/.control-center",
      dataRoot: "/home/owner/.local/share/control-center"
    })
    assert.include(notice, "/work/.control-center")
    assert.include(notice, "/home/owner/.local/share/control-center")
    assert.include(notice, "CONTROL_CENTER_DATA_ROOT=/work/.control-center control-center")
    assert.include(notice, "CONTROL_CENTER_DATA_ROOT=/work/.control-center control-center backup <archive>")
    assert.include(notice, "control-center restore <archive>")
    assert.notInclude(notice, "mv ")
  })
})

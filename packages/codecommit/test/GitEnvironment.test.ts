import { describe, expect, it } from "@effect/vitest"
import * as GitEnvironment from "../src/GitEnvironment.js"

describe("GitEnvironment", () => {
  it("clears every repository-local variable reported by Git", () => {
    expect(GitEnvironment.isolated()).toStrictEqual({
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_CONFIG: undefined,
      GIT_CONFIG_COUNT: undefined,
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_DIR: undefined,
      GIT_GRAFT_FILE: undefined,
      GIT_IMPLICIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_NO_REPLACE_OBJECTS: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_PREFIX: undefined,
      GIT_REPLACE_REF_BASE: undefined,
      GIT_SHALLOW_FILE: undefined,
      GIT_WORK_TREE: undefined
    })
  })

  it("disables terminal authentication without dropping repository tombstones", () => {
    expect(GitEnvironment.nonInteractive()).toStrictEqual({
      ...GitEnvironment.isolated(),
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "/bin/false",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: "/bin/false",
      SSH_ASKPASS_REQUIRE: "never"
    })
  })
})

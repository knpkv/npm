import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as Effect from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"

import { visualChildEnv } from "./environment.js"

test("child environment removes ambient provider inputs and mixed casing", async () => {
  const seeded = {
    AWS_ACCESS_KEY_ID: "fixture-key",
    Aws_Secret_Access_Key: "fixture-secret",
    AWS_SESSION_TOKEN: "fixture-session",
    AWS_PROFILE: "fixture-profile",
    aws_default_profile: "fixture-default",
    AWS_WEB_IDENTITY_TOKEN_FILE: "fixture-file",
    AWS_ROLE_ARN: "fixture-role",
    AWS_ROLE_SESSION_NAME: "fixture-role-session",
    AWS_REGION: "fixture-region",
    AWS_DEFAULT_REGION: "fixture-region",
    AtLaSsIaN_TOKEN: "fixture-token",
    CLOCKIFY_API_KEY: "fixture-clockify",
    CONTROL_CENTER_PORT: "9999"
  }
  const output = await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return yield* spawner.string(
        ChildProcess.make("node", [
          "-e",
          "console.log(JSON.stringify(Object.keys(process.env).filter(name => /^(AWS_|ATLASSIAN_|CLOCKIFY_|CONTROL_CENTER_)/i.test(name))))"
        ], {
          extendEnv: true,
          env: visualChildEnv(seeded, {})
        })
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
  expect(Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(output))).toEqual([
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE"
  ])
  expect(Object.values(visualChildEnv(seeded, {})).every((value) => value === undefined)).toBe(true)
})

/**
 * `jcf web login`: a fresh one-time link into the running jcf-web, for a second browser or an expired tab.
 *
 * @module
 */
import { Console, Effect } from "effect"
import { Command } from "effect/cli"
import { requestLoginUrl } from "../web/WebControl.js"
import { toCommandFailed } from "./CommandFailed.js"

const login = Command.make(
  "login",
  {},
  () =>
    requestLoginUrl.pipe(
      Effect.flatMap((url) => Console.log(`jcf week view: ${url}`)),
      Effect.mapError(toCommandFailed)
    )
).pipe(Command.withDescription("Print a fresh one-time link into the running jcf-web"))

export const web = Command.make(
  "web",
  {},
  () => Console.log("Start the week view with jcf-web. Get a new sign-in link with jcf web login.")
).pipe(
  Command.withDescription("The week view in a browser (jcf-web)"),
  Command.withSubcommands([login])
)

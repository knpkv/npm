/**
 * Ports for Playwright web servers, so two suites (or two copies of one) can
 * run at the same time.
 *
 * Playwright loads a config once in the runner and again in every worker. The
 * first load asks the OS for a free port and records it in `variable`; workers
 * inherit the runner's environment, so every load agrees on that port. Start
 * the server with a strict-port flag (`--strictPort`, `--exact-port`): if
 * another process takes the port before the server binds it, the run fails
 * loudly instead of serving on a different port than the tests use.
 */
import { Data, Option, Schema } from "effect"
import { createServer } from "node:net"
import { env } from "node:process"

/** The OS answered a port-0 listen without a TCP port. */
export class PlaywrightPortError extends Data.TaggedError("PlaywrightPortError")<{ readonly address: string }> {}

const decodeAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }))

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() =>
        Option.match(decodeAddress(address), {
          onNone: () => reject(new PlaywrightPortError({ address: JSON.stringify(address) })),
          onSome: ({ port }) => resolve(port)
        })
      )
    })
  })

/** The port recorded in `variable`, or a fresh free one recorded there for this run's workers. */
export const playwrightPort = async (variable: string): Promise<number> => {
  const recorded = env[variable]
  if (recorded !== undefined) return Number(recorded)
  const port = await freePort()
  env[variable] = String(port)
  return port
}

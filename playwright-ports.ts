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
 *
 * Only ports and Playwright output are per run. Each suite's build output
 * (`dist`, `storybook-static`) is still shared, so two copies of one suite can
 * run together over one build, but not while either is rebuilding it.
 */
import { Data, Option, Schema } from "effect"
import { readdirSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { env } from "node:process"

/** The OS answered a port-0 listen without a TCP port. */
export class PlaywrightPortError extends Data.TaggedError("PlaywrightPortError")<{ readonly address: string }> {}

/** The port variable already held something other than a TCP port (1–65535). */
export class PlaywrightPortVariableError
  extends Data.TaggedError("PlaywrightPortVariableError")<{ readonly value: string; readonly variable: string }>
{}

const isTcpPort = Schema.isBetween({ maximum: 65535, minimum: 1 })
const decodeAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Int.check(isTcpPort) }))
const decodeRecorded = Schema.decodeUnknownOption(Schema.NumberFromString.check(Schema.isInt(), isTcpPort))

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

/**
 * The port recorded in `variable`, or a fresh free one recorded there for this
 * run's workers. A recorded value that isn't a TCP port rejects with
 * `PlaywrightPortVariableError`.
 *
 * A free port is found by binding port 0 and closing that probe; the web
 * server binds the number moments later. Another process can take it in that
 * millisecond window. `--strictPort` then fails the run loudly instead of
 * serving on another port. Closing the window needs the server to bind port 0
 * and report its own origin to Playwright: backlog item P2 (arch lane).
 */
export const playwrightPort = async (variable: string): Promise<number> => {
  const recorded = env[variable]
  if (recorded !== undefined) {
    return Option.match(decodeRecorded(recorded), {
      onNone: () => Promise.reject(new PlaywrightPortVariableError({ value: recorded, variable })),
      onSome: (port) => Promise.resolve(port)
    })
  }
  const port = await freePort()
  env[variable] = String(port)
  return port
}

/**
 * Keeps `--last-failed` working across runs whose `outputDir` differs by
 * port: Playwright reads and writes its last-run file at `file` instead of
 * inside `outputDir`. An explicit `PLAYWRIGHT_LAST_RUN_OUTPUT_FILE` wins.
 * When two copies run at once, the one that finishes last is the last run.
 */
export const keepLastRunAt = (file: string): void => {
  env["PLAYWRIGHT_LAST_RUN_OUTPUT_FILE"] ??= file
}

/**
 * Removes this suite's earlier run directories (`<prefix><port>` under
 * `parent`) that nothing has written to for `maxAgeMillis`. Playwright only
 * empties the current run's `outputDir`, so without this every run's folder
 * stays forever. A concurrent run is minutes old and is never touched.
 * Returns the removed directory names.
 */
export const pruneStaleRunDirectories = (
  parent: string,
  prefix: string,
  maxAgeMillis: number,
  now: number
): ReadonlyArray<string> => {
  const entries = (() => {
    try {
      return readdirSync(parent, { withFileTypes: true })
    } catch {
      return []
    }
  })()
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || !/^\d+$/.test(entry.name.slice(prefix.length))) {
      return []
    }
    const path = join(parent, entry.name)
    if (now - statSync(path).mtimeMs <= maxAgeMillis) return []
    rmSync(path, { force: true, recursive: true })
    return [entry.name]
  })
}

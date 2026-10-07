/**
 * Fake hub for Connect browser tests and before/after measurement.
 *
 * Serves the real Connect bundle and one agent whose session behaves like herdr: the server keeps
 * the scrollback, the client only sends whole-line `terminal.scroll` commands, and every change is
 * a full re-rendered screen. Query parameters on the session URL are ignored; behaviour comes from
 * the environment so Playwright and manual measurement use the same server:
 *
 * - `CONNECT_FIXTURE_PORT`   listen port (0 picks a free one; the chosen port is printed)
 * - `CONNECT_FIXTURE_RTT_MS` delay before a scroll is rendered, standing in for the hub round trip
 * - `CONNECT_FIXTURE_TICK_MS` append one output line every N ms (0 = quiet pane)
 *
 * `GET /__test/commands` returns every client command received with its arrival time
 * (`Date.now()`); `POST /__test/reset` clears them. `GET /__test/screen` returns the latest
 * session's rows and size, so tests can aim at text and measurements can read the top line.
 * `POST /__test/scroll-state?mode=known|unknown&start=N` makes the next sessions report their scroll
 * position as the hub does — off by default, which is how a hub without that signal behaves.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Config, Console, Effect, Option, Schema } from "effect"
import { build } from "esbuild"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { type WebSocket, WebSocketServer } from "ws"
import { TerminalClientCommand } from "../../src/model.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const settings = Config.all({
  port: Config.Int("CONNECT_FIXTURE_PORT").pipe(Config.withDefault(0)),
  rttMs: Config.Int("CONNECT_FIXTURE_RTT_MS").pipe(Config.withDefault(40)),
  tickMs: Config.Int("CONNECT_FIXTURE_TICK_MS").pipe(Config.withDefault(0))
})

/** How the fake herdr behaves: scroll round trip, and how often a streamed line is appended. */
interface SessionTiming {
  readonly rttMs: number
  readonly tickMs: number
}

const bundle = await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: { connect: "test/browser/fixture-entry.tsx" },
  format: "iife",
  loader: { ".woff2": "file" },
  outdir: "fixture-out",
  platform: "browser",
  target: "es2022",
  write: false
})
const asset = (suffix: string): string => {
  const file = bundle.outputFiles.find((output) => output.path.endsWith(suffix))
  if (file === undefined) throw new Error(`fixture bundle has no ${suffix}`)
  return file.text
}
const script = asset("connect.js")
const styles = asset("connect.css")

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Fleet connect fixture</title>
<link rel="stylesheet" href="/assets/connect.css">
</head>
<body data-rly-root data-rly-theme="dark" class="connect-body">
<div id="fleet-connect-root"></div>
<script src="/assets/connect.js" defer></script>
</body>
</html>`

const agent = {
  host: "FIXTURE",
  id: "agent-fixture",
  kind: "codex",
  lastActivityAt: 1_000,
  name: "fixture-pane",
  state: "working",
  work: "npm"
}

/** History lines: numbered, with plain URLs, an unsafe scheme and one row that wraps at 80 columns. */
const initialHistory = (): Array<string> =>
  Array.from({ length: 300 }, (_, index) => {
    const line = String(index + 1).padStart(3, "0")
    if (index === 280) return `${line} docs https://example.test/guide?step=2, then retry.`
    if (index === 282) return `${line} unsafe javascript:alert(1) and file:///etc/passwd stay text`
    if (index === 284) return `${line} ${"long-command --flag ".repeat(6)}https://example.test/wrapped/path`
    return `${line} output line`
  })

/** A client command as the fixture received it. */
interface ReceivedCommand {
  readonly at: number
  readonly command: TerminalClientCommand
}

/** The rows the latest session last rendered. */
interface FixtureScreen {
  readonly cols: number
  readonly rows: ReadonlyArray<string>
}

const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(TerminalClientCommand))
const commands: Array<ReceivedCommand> = []
let latestScreen: FixtureScreen = { cols: 0, rows: [] }

/** Whether sessions report their scroll position, and where a new session starts. */
interface ScrollStateMode {
  readonly report: "off" | "known" | "unknown"
  readonly startOffset: number
}
let scrollStateMode: ScrollStateMode = { report: "off", startOffset: 0 }

/** One session: a screen of `rows` lines ending `offset` lines above the newest. */
const session = (socket: WebSocket, cols: number, rows: number, { rttMs, tickMs }: SessionTiming) => {
  const history = initialHistory()
  let offset = scrollStateMode.startOffset
  let width = cols
  let height = rows
  // Soft-wraps long lines to the terminal width, as the pane would before herdr renders it.
  const screenRows = (): Array<string> => {
    const wrapped = history.flatMap((line) => {
      const parts: Array<string> = []
      for (let start = 0; start < line.length; start += width) parts.push(line.slice(start, start + width))
      return parts.length === 0 ? [""] : parts
    })
    const maximum = Math.max(0, wrapped.length - height)
    offset = Math.min(Math.max(0, offset), maximum)
    const end = wrapped.length - offset
    return wrapped.slice(Math.max(0, end - height), end)
  }
  const reportScroll = (): void => {
    if (scrollStateMode.report === "off") return
    screenRows()
    const offsetFromBottom = scrollStateMode.report === "known" ? offset : null
    socket.send(JSON.stringify({ type: "terminal.scroll_state", offsetFromBottom }))
  }
  const render = (): void => {
    if (socket.readyState !== socket.OPEN) return
    latestScreen = { cols: width, rows: screenRows() }
    // Erase-to-end only on short rows: at the last column it would erase the final character.
    const body = screenRows()
      .map((row, index) => `\u001b[${index + 1};1H${row}${row.length < width ? "\u001b[K" : ""}`)
      .join("")
    reportScroll()
    socket.send(Buffer.from(`\u001b[?25l\u001b[H\u001b[2J${body}`), { binary: true })
  }
  socket.send(JSON.stringify({ type: "terminal.ready" }))
  render()
  const ticker = tickMs > 0
    ? setInterval(() => {
      history.push(`${String(history.length + 1).padStart(3, "0")} streamed output`)
      // Keep the reader's place while they are scrolled back, like a pager would.
      if (offset > 0) offset += 1
      render()
    }, tickMs)
    : undefined
  socket.on("message", (data) => {
    const decoded = decodeCommand(String(data))
    if (Option.isNone(decoded)) return
    const command = decoded.value
    commands.push({ at: Date.now(), command })
    if (command.type === "terminal.scroll") {
      setTimeout(() => {
        offset += command.direction === "up" ? command.lines : -command.lines
        render()
      }, rttMs)
    }
    if (command.type === "terminal.resize") {
      width = command.cols
      height = command.rows
      render()
    }
  })
  socket.on("close", () => {
    if (ticker !== undefined) clearInterval(ticker)
  })
}

const json = (response: ServerResponse, body: string): void => {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(body)
}

const handle = (request: IncomingMessage, response: ServerResponse): void => {
  const url = new URL(request.url ?? "/", "http://fixture.test")
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(page)
  } else if (url.pathname === "/assets/connect.js") {
    response.writeHead(200, { "content-type": "text/javascript" })
    response.end(script)
  } else if (url.pathname === "/assets/connect.css") {
    response.writeHead(200, { "content-type": "text/css" })
    response.end(styles)
  } else if (url.pathname === "/v1/connect/agents") {
    json(response, JSON.stringify({ agents: [agent], failures: [], nextCursor: null }))
  } else if (url.pathname === "/__test/screen") {
    json(response, JSON.stringify(latestScreen))
  } else if (url.pathname === "/__test/commands") {
    json(response, JSON.stringify(commands))
  } else if (url.pathname === "/__test/scroll-state" && request.method === "POST") {
    const mode = url.searchParams.get("mode")
    scrollStateMode = {
      report: mode === "known" || mode === "unknown" ? mode : "off",
      startOffset: Number(url.searchParams.get("start") ?? "0")
    }
    json(response, JSON.stringify(scrollStateMode))
  } else if (url.pathname === "/__test/reset" && request.method === "POST") {
    commands.length = 0
    scrollStateMode = { report: "off", startOffset: 0 }
    json(response, JSON.stringify({ ok: true }))
  } else {
    response.writeHead(404)
    response.end()
  }
}

const ListeningAddress = Schema.Struct({ port: Schema.Number })

const main = Effect.gen(function*() {
  const { port, rttMs, tickMs } = yield* settings
  const server = createServer(handle)
  const sockets = new WebSocketServer({ noServer: true })
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://fixture.test")
    if (url.pathname !== "/v1/connect/session") {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(
      request,
      socket,
      head,
      (client) =>
        session(client, Number(url.searchParams.get("cols") ?? "80"), Number(url.searchParams.get("rows") ?? "24"), {
          rttMs,
          tickMs
        })
    )
  })
  const listening = yield* Effect.callback<number>((resume) => {
    server.listen(port, "127.0.0.1", () =>
      resume(Effect.succeed(
        Schema.decodeUnknownOption(ListeningAddress)(server.address()).pipe(
          Option.match({ onNone: () => port, onSome: (address) => address.port })
        )
      )))
  })
  yield* Console.log(`connect fixture http://127.0.0.1:${listening}/`)
  return yield* Effect.never
})

NodeRuntime.runMain(main)

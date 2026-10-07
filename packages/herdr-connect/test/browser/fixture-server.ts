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
 * - `CONNECT_FIXTURE_AGENTS_FILE` serve this saved `/v1/connect/agents` body instead of the one fake
 *   agent, to look at a real fleet's directory (a read-only snapshot, never committed)
 *
 * `GET /__test/commands` returns every client command received with its arrival time
 * (`Date.now()`); `POST /__test/reset` clears them. `GET /__test/screen` returns the latest
 * session's rows and size, so tests can aim at text and measurements can read the top line.
 * `POST /__test/scroll-state?mode=known|unknown&start=N` makes the next sessions report their scroll
 * position as the hub does — off by default, which is how a hub without that signal behaves; `lines=N`
 * gives them N lines of history instead of 300, `chase=N` streams 5 lines behind each of the first N
 * down-scrolls (output arriving while Latest runs), `delay=ms` delivers readings that late, and
 * `rtt=ms` holds each scroll that long before it renders, and `clampSilent=1` draws no frame for a
 * scroll clamped at an end (its reading still comes). `POST /__test/scroll-state/mute?on=1` holds readings
 * back, as a slow or rate-limited hub would; `POST /__test/grow?lines=N` streams N lines into the
 * latest session without a reading, and `POST /__test/reading?offset=N&scrolls=M` sends it a
 * reading right away, stamped as taken after M forwarded scrolls (default: all received so far) — a
 * stale one when M is lower, as a late `herdr pane get` would be (`offset=null` for a read that
 * failed). Ordinary readings are quiet: sent once no scroll has been in flight for 350 ms. Readings only go to
 * sessions whose URL opted in with `scrollState=1`, like the real hosts. `GET /__test/in-flight`
 * returns the most scroll commands that were ever waiting to render at once, and
 * `GET /__test/readings` how many quiet readings sessions have sent since the last reset.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, FileSystem, Option, Schema } from "effect"
import { build } from "esbuild"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { type WebSocket, WebSocketServer } from "ws"
import { TerminalClientCommand } from "../../src/model.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const settings = Config.all({
  port: Config.Int("CONNECT_FIXTURE_PORT").pipe(Config.withDefault(0)),
  rttMs: Config.Int("CONNECT_FIXTURE_RTT_MS").pipe(Config.withDefault(40)),
  tickMs: Config.Int("CONNECT_FIXTURE_TICK_MS").pipe(Config.withDefault(0)),
  agentsFile: Config.option(Config.String("CONNECT_FIXTURE_AGENTS_FILE"))
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
const initialHistory = (length: number): Array<string> =>
  Array.from({ length }, (_, index) => {
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
  readonly historyLines: number
  readonly chaseScrolls: number
  readonly readingDelayMs: number
  // Overrides the server's scroll round trip for new sessions, to hold a page in flight.
  readonly rttMs: number | null
  // A scroll clamped at an end changes nothing, so herdr draws no frame for it.
  readonly clampSilent: boolean
}
const defaultScrollStateMode: ScrollStateMode = {
  report: "off",
  startOffset: 0,
  historyLines: 300,
  chaseScrolls: 0,
  readingDelayMs: 0,
  rttMs: null,
  clampSilent: false
}
let scrollStateMode = defaultScrollStateMode
let readingsMuted = false
let scrollsInFlight = 0
let mostScrollsInFlight = 0
let growLatest: (lines: number) => void = () => {}
let readingToLatest: (offsetFromBottom: number | null, scrollsForwarded: number | null) => void = () => {}
/** Like the hub, readings wait until no scroll has been in flight for this long. */
const quietReadingMs = 350
let readingsSent = 0

/** One session: a screen of `rows` lines ending `offset` lines above the newest. */
const session = (
  socket: WebSocket,
  cols: number,
  rows: number,
  optedIn: boolean,
  { rttMs, tickMs }: SessionTiming
) => {
  const history = initialHistory(scrollStateMode.historyLines)
  let offset = scrollStateMode.startOffset
  let width = cols
  let height = rows
  let chaseLeft = scrollStateMode.chaseScrolls
  const scrollRttMs = scrollStateMode.rttMs ?? rttMs
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
  let pendingScrolls = 0
  // Scroll commands received, as the hub counts those it forwarded; readings carry it.
  let receivedScrolls = 0
  let readingTimer: ReturnType<typeof setTimeout> | undefined
  // A quiet reading, as the hub takes it: once no scroll has been in flight for a while, sampled
  // then and delivered `delay` later.
  const reportScroll = (): void => {
    if (scrollStateMode.report === "off" || readingsMuted || !optedIn) return
    if (readingTimer !== undefined) clearTimeout(readingTimer)
    readingTimer = setTimeout(() => {
      readingTimer = undefined
      if (pendingScrolls > 0 || readingsMuted || socket.readyState !== socket.OPEN) return
      screenRows()
      const reading = JSON.stringify({
        type: "terminal.scroll_state",
        offsetFromBottom: scrollStateMode.report === "known" ? offset : null,
        scrollsForwarded: receivedScrolls
      })
      setTimeout(() => {
        if (socket.readyState !== socket.OPEN) return
        socket.send(reading)
        readingsSent += 1
      }, scrollStateMode.readingDelayMs)
    }, quietReadingMs)
  }
  const render = (report = true): void => {
    if (socket.readyState !== socket.OPEN) return
    latestScreen = { cols: width, rows: screenRows() }
    // Erase-to-end only on short rows: at the last column it would erase the final character.
    const body = screenRows()
      .map((row, index) => `\u001b[${index + 1};1H${row}${row.length < width ? "\u001b[K" : ""}`)
      .join("")
    if (report) reportScroll()
    socket.send(Buffer.from(`\u001b[?25l\u001b[H\u001b[2J${body}`), { binary: true })
  }
  // Keep the reader's place while they are scrolled back, like a pager would.
  const stream = (lines: number, report: boolean): void => {
    for (let line = 0; line < lines; line += 1) {
      history.push(`${String(history.length + 1).padStart(3, "0")} streamed output`)
      if (offset > 0) offset += 1
    }
    render(report)
  }
  growLatest = (lines) => stream(lines, false)
  readingToLatest = (offsetFromBottom, scrollsForwarded) =>
    socket.send(
      JSON.stringify({
        type: "terminal.scroll_state",
        offsetFromBottom,
        scrollsForwarded: scrollsForwarded ?? receivedScrolls
      })
    )
  socket.send(JSON.stringify({ type: "terminal.ready" }))
  render()
  const ticker = tickMs > 0 ? setInterval(() => stream(1, true), tickMs) : undefined
  socket.on("message", (data) => {
    const decoded = decodeCommand(String(data))
    if (Option.isNone(decoded)) return
    const command = decoded.value
    commands.push({ at: Date.now(), command })
    if (command.type === "terminal.scroll") {
      scrollsInFlight += 1
      pendingScrolls += 1
      receivedScrolls += 1
      mostScrollsInFlight = Math.max(mostScrollsInFlight, scrollsInFlight)
      setTimeout(() => {
        scrollsInFlight -= 1
        pendingScrolls -= 1
        // Output that lands while the pane is still behind, just before herdr applies this page.
        if (command.direction === "down" && chaseLeft > 0) {
          chaseLeft -= 1
          for (let line = 0; line < 5; line += 1) {
            history.push(`${String(history.length + 1).padStart(3, "0")} streamed output`)
            if (offset > 0) offset += 1
          }
        }
        const before = offset
        offset += command.direction === "up" ? command.lines : -command.lines
        screenRows()
        if (scrollStateMode.clampSilent && offset === before) reportScroll()
        else render()
      }, scrollRttMs)
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

const handle = (agentsBody: string) => (request: IncomingMessage, response: ServerResponse): void => {
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
    json(response, agentsBody)
  } else if (url.pathname === "/__test/screen") {
    json(response, JSON.stringify(latestScreen))
  } else if (url.pathname === "/__test/commands") {
    json(response, JSON.stringify(commands))
  } else if (url.pathname === "/__test/scroll-state" && request.method === "POST") {
    const mode = url.searchParams.get("mode")
    scrollStateMode = {
      report: mode === "known" || mode === "unknown" ? mode : "off",
      startOffset: Number(url.searchParams.get("start") ?? "0"),
      historyLines: Number(url.searchParams.get("lines") ?? "300"),
      chaseScrolls: Number(url.searchParams.get("chase") ?? "0"),
      readingDelayMs: Number(url.searchParams.get("delay") ?? "0"),
      rttMs: url.searchParams.has("rtt") ? Number(url.searchParams.get("rtt")) : null,
      clampSilent: url.searchParams.get("clampSilent") === "1"
    }
    json(response, JSON.stringify(scrollStateMode))
  } else if (url.pathname === "/__test/scroll-state/mute" && request.method === "POST") {
    readingsMuted = url.searchParams.get("on") === "1"
    json(response, JSON.stringify({ muted: readingsMuted }))
  } else if (url.pathname === "/__test/grow" && request.method === "POST") {
    growLatest(Number(url.searchParams.get("lines") ?? "1"))
    json(response, JSON.stringify({ ok: true }))
  } else if (url.pathname === "/__test/reading" && request.method === "POST") {
    const offset = url.searchParams.get("offset") ?? "0"
    const scrolls = url.searchParams.get("scrolls")
    readingToLatest(offset === "null" ? null : Number(offset), scrolls === null ? null : Number(scrolls))
    json(response, JSON.stringify({ ok: true }))
  } else if (url.pathname === "/__test/readings") {
    json(response, JSON.stringify({ sent: readingsSent }))
  } else if (url.pathname === "/__test/in-flight") {
    json(response, JSON.stringify({ most: mostScrollsInFlight }))
  } else if (url.pathname === "/__test/reset" && request.method === "POST") {
    commands.length = 0
    scrollStateMode = defaultScrollStateMode
    readingsMuted = false
    readingsSent = 0
    mostScrollsInFlight = scrollsInFlight
    json(response, JSON.stringify({ ok: true }))
  } else {
    response.writeHead(404)
    response.end()
  }
}

const ListeningAddress = Schema.Struct({ port: Schema.Number })

const main = Effect.gen(function*() {
  const { agentsFile, port, rttMs, tickMs } = yield* settings
  const fileSystem = yield* FileSystem.FileSystem
  const agentsBody = yield* Option.match(agentsFile, {
    onNone: () => Effect.succeed(JSON.stringify({ agents: [agent], failures: [], nextCursor: null })),
    onSome: (file) => fileSystem.readFileString(file)
  })
  const server = createServer(handle(agentsBody))
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
        session(
          client,
          Number(url.searchParams.get("cols") ?? "80"),
          Number(url.searchParams.get("rows") ?? "24"),
          url.searchParams.get("scrollState") === "1",
          { rttMs, tickMs }
        )
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

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))

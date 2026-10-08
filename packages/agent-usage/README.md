# @knpkv/agent-usage

Claude and Codex subscription usage on this machine, in a browser: how much was used, on which
ticket, over time, and how close each 5-hour and weekly limit came to running out.

A long-running local process reads Claude Code transcripts and Codex rollouts as they grow, keeps
every model request in a private SQLite store, polls Claude's limits, and serves one page:

- **tiles** for every limit window and balance actually observed (Claude 5h and weekly, Codex
  windows, Codex credits, Claude extra usage), each with its age or the reason it could not be read
- **usage by booking**: a column per hour or day, stacked by the eight largest tickets or repos plus
  Other, in API-equivalent dollars or tokens
- **subscription limits** as step lines on the same time axis, so a jump sits over the work that
  caused it
- a **booking table** with the token breakdown; clicking a row draws only that booking
- an **ingest status** line: files read, lines skipped, paths it could not read

## Running it

Installed from npm, the binary is `agent-usage` (`agent-usage serve`, `agent-usage login`,
`agent-usage ingest`, `agent-usage limits`). From this repository:

```bash
pnpm build                                       # builds the workspace, this package included
pnpm --filter @knpkv/agent-usage start serve     # prints the URL that gets you in
pnpm --filter @knpkv/agent-usage start login     # a fresh URL from the running server; --open opens it
pnpm --filter @knpkv/agent-usage start ingest    # one pass, then a summary; --json for one JSON value
```

`serve` ingests every minute and polls Claude's limits every five. The page stays current by
itself: after each ingest pass and limit poll is stored, the server tells the page over a WebSocket
(`/api/live`, admitted by the same session cookie and origin checks as every read) which reads
changed, and the page refetches only those. A dropped socket reconnects with backoff and refetches
everything once; the header says how long ago the page was updated, or that it is reconnecting.
The printed URL carries a
one-time code in its fragment; opening it exchanges the code for a session cookie and strips it from
the address bar. The code works once and expires a minute after it was printed. The server only
listens on loopback and only answers reads.

Besides usage per period (`/api/usage`), limits (`/api/limits`) and status (`/api/status`), the
server answers one Booking's sessions in a range: `/api/sessions?from&to&booking&agent`, with
`booking` as the usage report names it (`ticket:RLY-142`, `repo:app`). Each session row carries its
first and last request in the range, requests, tokens and API-equivalent cost on that Booking only:
a session that worked on two Bookings appears under each with its part. A range covers at most 92
days. The list is capped at 200 rows, most cost first, with a count of the rest. Sessions are never given a share of a limit.

### Getting back in

`agent-usage login` asks the running server for a fresh link and prints it; `agent-usage login
--open` also opens it in the browser (`xdg-open` on Linux, `open` on macOS). Each link follows the
startup link's rules: one use, one minute, and a newer link replaces one not yet used. Use it when
the startup link has expired, the session cookie is gone, or the server runs as a service whose
output you do not watch.

`login` reaches the server over a Unix socket, `serve.sock` in the store directory. The directory
is owner-only and the socket `0600`, so only the store's owner can ask; the server refuses to bind,
and `login` to connect, when the path is a symlink, not a socket, or owned by another user. Either
side gives up on the other after five seconds, and no link is minted before the server is listening.

One server runs per store. `serve` first takes an exclusive lock on `serve.lock` in the store
directory and holds it while it runs; the operating system releases it when the process ends,
however it ends. A second `serve` on the same store exits with an error before binding a port, and
the next start after a crash replaces the socket the dead server left. A Unix socket path holds
about a hundred bytes (103 here): a store directory deeper than that still runs, one server at a
time, but logs that `login` is unavailable, and `login` says to choose a shorter `AGENT_USAGE_HOME`.

| `login` says                                 | Meaning                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agent-usage is not running on this store`   | Nothing listens on the socket: start `serve` or its service, or restart a server older than `login`, which has no socket |
| `refused its control socket … : <reason>`    | Something other than the server's own socket is at the path                                                              |
| `control socket … could not be used (<why>)` | The socket exists but this process may not connect to it                                                                 |
| `did not answer with a link`                 | Something answered on the socket with a reply that is not a sign-in link                                                 |

Every failure exits nonzero and prints nothing on stdout, so `agent-usage login | xargs …` is safe.

### Limits for another program

`agent-usage limits` asks the running server for this Machine's latest limits over the same
owner-only control socket and prints them as one JSON line: `{ machine, observedAt, latest, balances }`.
`latest` holds the newest snapshot of every limit window, the same tiles as the page's "Limits now".
A window that could not be read stays an `Unknown` snapshot with its reason; it is never reported as
0%. `observedAt` is the server's clock when it answered, and every time in the reply is on that
clock. No session cookie and no provider credential is involved, so hostd can call it to show limits
in Connect. With no server running it prints why on stderr and exits nonzero, like `login`.

### Running as a service

`serve` needs no terminal: it reads nothing from stdin and prints the startup link to stdout once.
Run it under the service manager and get in with `agent-usage login --open`. It reads its
configuration from the environment ([Configuration](#configuration)); set `AGENT_USAGE_HOME` and
`PORT` there when the defaults do not suit. Point `ExecStart` / `ProgramArguments` at the installed
binary (`command -v agent-usage`).

systemd user unit, `~/.config/systemd/user/agent-usage.service`:

```ini
[Unit]
Description=agent-usage: Claude and Codex usage over time

[Service]
ExecStart=%h/.local/bin/agent-usage serve
Restart=on-failure
# Environment=AGENT_USAGE_HOME=%h/.local/share/agent-usage
# Environment=PORT=3112

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now agent-usage
journalctl --user -u agent-usage    # its output
```

Under a service manager stdout goes to the journal or a log file, so the startup link lands there.
It is spent on first use and dead a minute after startup either way; `login` links never leave the
`login` process.

launchd agent, `~/Library/LaunchAgents/dev.knpkv.agent-usage.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.knpkv.agent-usage</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/agent-usage</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.knpkv.agent-usage.plist
```

A service's environment is not your shell's: if Claude Code or Codex keep their files somewhere
other than the defaults (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), set the same variables for the service.
On macOS, the Keychain lookup for Claude's token needs the service to run in your login session (a
LaunchAgent does; a LaunchDaemon does not).

The first pass backfills everything on disk (on a machine with ~9 GB of Codex rollouts, under a
minute); later passes read only what was appended. A line longer than 32 MiB (a huge pasted tool
output) is skipped and counted in the status line rather than held in memory.

For development, `pnpm --filter @knpkv/agent-usage dev` runs the server and Vite together.

## Configuration

| Variable                          | Default                                                             | Meaning                                                                   |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `PORT`                            | `3112`                                                              | Port to bind on `127.0.0.1`                                               |
| `AGENT_USAGE_HOME`                | `~/.local/share/agent-usage`                                        | Store directory; must be `0700`, created so when missing                  |
| `AGENT_USAGE_MACHINE`             | short, lower-cased hostname                                         | Machine name stamped on every row                                         |
| `AGENT_USAGE_PROJECTS`            | none                                                                | Extra Known Projects, comma-separated (`RPS,ABC`)                         |
| `CLAUDE_CONFIG_DIR`               | `~/.claude`                                                         | Claude Code's config; transcripts are read from `projects/` below it      |
| `CODEX_HOME`                      | `~/.codex`                                                          | Codex's home; rollouts are read from `sessions/` and `archived_sessions/` |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | unset                                                               | Where Claude Code keeps credentials when not in its config directory      |
| `AGENT_USAGE_CLAUDE_LIMITS`       | `${XDG_STATE_HOME:-~/.local/state}/agent-usage/claude-limits.jsonl` | The claude-statusline limit log, read like a transcript                   |

Ticket titles come from `acli jira workitem search` when `acli` is installed, cached for a day in
the store. Without it, tickets show their key and the status line says why.

## What a request is booked to

A request's **booking** is the first of:

1. the Jira key its git branch names (`feat/RPS-12`, `feature_RPS-12_x`)
2. the deepest Jira key in its working directory (`…/worktrees/app/RPS-12`)
3. the one key the human typed into the session, if its project is a **Known Project**
4. otherwise its repo: the `worktrees/<repo>/` segment, or the directory name

Known Projects are those some branch or worktree path has named, plus `AGENT_USAGE_PROJECTS`. Typed
text is full of ticket-shaped strings that are not tickets (`GPT-6`, `SHA-256`, `CVE-2026`); those
book to the repo, and the page lists them by prefix with their request counts. Keys inside text the
agent injected (instruction files, system reminders, environment blocks) and the task a parent agent
hands a subagent are never read.

Bookings and costs are worked out when the page asks, not when a request is stored, so a sharper
rule or a newly priced model applies to all history, including sessions whose transcripts Claude
Code has since deleted.

## Cost

API-equivalent cost is what the tokens would cost at **today's** list price, from a price table in
this package, applied to all history alike. It is not what a subscription charges. Tokens of a model
with no price are shown as unpriced, never as $0.

## Limits

- **Claude** limits appear in no transcript. They are polled from `GET
https://api.anthropic.com/api/oauth/usage`, the endpoint Claude Code's `/usage` dialog reads, with
  the OAuth access token Claude Code already holds: `.credentials.json` in its secure-storage
  directory (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`), or on
  macOS the login Keychain item Claude Code itself reads, `Claude Code-credentials` under your user
  name, suffixed with `-` and the first eight hex digits of the directory's SHA-256 whenever a
  non-default directory is set. The token is server-private: it is read per poll, sent only in that
  request's `Authorization` header to `api.anthropic.com` with redirects refused, and never stored,
  logged, refreshed or put in an error. A failed poll is stored as an Unknown reading with its
  reason and what exactly went wrong (no credentials file, no Keychain item, the Keychain refusing
  access with `security`'s exit code, an expired token, an HTTP status, an unreadable reply), shown
  on hover or focus of the hatched gap and in the readings table.
- **claude-statusline** appends a line to its limit log whenever a Claude window's reading moves
  (`{"v":1,"observedAt":<ms>,"machine":"<hostname>","window":"five_hour"|"seven_day"|"spend",
"usedPercentage":<number>,"resetsAt":<ms|null>}`). The log is read incrementally like a
  transcript and recorded as Limit Snapshots of this Machine next to the polls, so a window is one
  series whichever observed it. A repeated reading (same machine, window, reset and percentage) is
  kept once; a line that does not decode, or another format version, is skipped and counted in the
  status line. `spend` is the apps gateway's spend limit, shown as the Spend row.
- **Codex** writes its account limits and credit balance into every rollout, so its limit history
  is backfilled from old sessions. Only the account-level `codex` limit is read; model-scoped limits
  are left out. A forked subagent rollout begins with a copy of its parent's history; that copy is
  not counted again. Codex repeats its limits on every request, so a reading is kept when it
  changes and otherwise at most every ten minutes.

A reading holds until the next one or until its window resets, whichever comes first. The page
never splits a limit's percentage across tickets: providers weight models and caching in ways they
do not publish, so any split would be invented.

## Privacy

- The store holds token counts, model, time, session id, working directory, branch and the typed
  ticket key. It has no column for prompt or response text; prompts are read only to find the typed
  ticket key and dropped.
- The store directory must be owner-only (`0700`); the database and its WAL/SHM files are kept
  `0600`, and a symlinked store directory or database file is refused.
- Nothing leaves the machine except the Claude limit poll to Anthropic and, when installed, `acli`
  lookups of ticket keys against your Jira.
- The session cookie (`agent_usage_owner`, `HttpOnly`, `SameSite=Strict`, path `/api`) is minted per
  process. One-time codes are minted at startup and on each `agent-usage login`; they reach only
  stdout of `serve` or `login`, are never logged, and with `--open` are on the opener's command line
  for the moment it runs.

Each machine keeps its own store. Every row names its machine, so a combined view across machines
can come later without migrating anything.

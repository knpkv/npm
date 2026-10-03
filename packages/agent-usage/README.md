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

```bash
pnpm --filter @knpkv/agent-usage build
agent-usage serve      # prints the URL that gets you in
agent-usage ingest     # one pass, then a summary; --json prints the status as one JSON value
```

`serve` ingests every minute and polls Claude's limits every five. The printed URL carries a
one-time code in its fragment; opening it exchanges the code for a session cookie and strips it from
the address bar. The code expires a minute after the server binds, so restart for a fresh one. The
server only listens on loopback and only answers reads.

The first pass backfills everything on disk (on a machine with ~9 GB of Codex rollouts, under a
minute); later passes read only what was appended. A line longer than 32 MiB (a huge pasted tool
output) is skipped and counted in the status line rather than held in memory.

For development, `pnpm --filter @knpkv/agent-usage dev` runs the server and Vite together.

## Configuration

| Variable               | Default                      | Meaning                                                                   |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `PORT`                 | `3112`                       | Port to bind on `127.0.0.1`                                               |
| `AGENT_USAGE_HOME`     | `~/.local/share/agent-usage` | Store directory; must be `0700`, created so when missing                  |
| `AGENT_USAGE_MACHINE`  | short, lower-cased hostname  | Machine name stamped on every row                                         |
| `AGENT_USAGE_PROJECTS` | none                         | Extra Known Projects, comma-separated (`RPS,ABC`)                         |
| `CLAUDE_CONFIG_DIR`    | `~/.claude`                  | Claude Code's config; transcripts are read from `projects/` below it      |
| `CODEX_HOME`           | `~/.codex`                   | Codex's home; rollouts are read from `sessions/` and `archived_sessions/` |

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
  the OAuth access token Claude Code already holds (`<CLAUDE_CONFIG_DIR>/.credentials.json`, or the
  macOS login Keychain item `Claude Code-credentials`). The token is server-private: it is read per
  poll, sent only in that request's `Authorization` header to `api.anthropic.com` with redirects
  refused, and never stored, logged, refreshed or put in an error. A failed poll is stored as an
  Unknown reading with its reason, so the gap shows.
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
- The session cookie (`agent_usage_owner`, `HttpOnly`, `SameSite=Strict`, path `/api`) and the
  one-time bootstrap code are minted per process; the code is printed to stdout only, never logged.

Each machine keeps its own store. Every row names its machine, so a combined view across machines
can come later without migrating anything.

# Agent Usage

Agent Usage is the context for recording how Claude and Codex subscription usage was consumed on one Machine, over time and per Booking, and how close each subscription limit came to running out.

## Language

### Sources

**Agent**:
A coding-agent runtime whose usage is recorded: Claude or Codex. The set is closed.
_Avoid_: Runtime, provider, tool

**Machine**:
The host whose agent transcripts and rollouts a store records, named by the configured machine id or the short lower-cased hostname. A renamed host is a second Machine.
_Avoid_: Host, device, node

### Usage

**Usage Event**:
One model request's token counts, placed in time on one Machine, with its Agent, model, session, and Attribution Inputs. Never carries prompt or response text.
_Avoid_: Sample, record, request log

**Attribution Inputs**:
The facts captured with a Usage Event that decide its Booking: working directory, branch, and the Active Ticket.
_Avoid_: Bucket, attribution

**Active Ticket**:
The single ticket key the human typed into an otherwise shared session at the time of a request. Keys inside injected context (agent instructions, system reminders, environment blocks) never count.
_Avoid_: Current ticket, mentioned ticket

**Known Project**:
A Jira project a branch or worktree path in the store has named, or one listed in configuration. An Active Ticket only counts when its project is a Known Project.
_Avoid_: Allowed prefix, project allowlist

**Booking**:
What a Usage Event's consumption counts toward: a Ticket when its branch or path names one, or its Active Ticket belongs to a Known Project; otherwise its Repo. Derived when read, never stored.
_Avoid_: Bucket (session-counter's word for the same thing), project, category

**API-Equivalent Cost**:
What a Usage Event's tokens would cost at the current list price, applied to all history alike. Unknown when the model has no price; never zero.
_Avoid_: Spend, bill, cost

### Limits

**Limit Window**:
A rolling subscription allowance the provider meters as a percentage, such as Claude's five-hour or weekly window or Codex's account limit. Its length may be unknown.
_Avoid_: Quota, rate limit bucket

**Limit Snapshot**:
One observation of a Limit Window's used percentage and reset time, or a typed reason it could not be read.
_Avoid_: Limit sample, usage reading

**Balance Reading**:
One observation of a spendable balance that is not a percentage: Codex credits or Claude extra usage. Known with a value, or Unknown with a reason.
_Avoid_: Credits, limit

### Ingestion

**Ingest Cursor**:
How far a store has read one source file, persisted so later passes read only what was appended.
_Avoid_: Offset, checkpoint, watermark

**Ingest Status**:
What the latest ingest pass found per source: files scanned, events added, and everything skipped, by reason. Held only while the server runs.
_Avoid_: Health, ingest log

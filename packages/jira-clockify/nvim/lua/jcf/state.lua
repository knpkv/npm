local M = {}
local uv = vim.loop or vim.uv
local cached = { active = false }
local last_key = nil
local last_path = nil
local poll_timer = nil
local poll_job = nil
-- Config captured by `start_poll`, so the command and its lock/stamp paths stay
-- stable for the lifetime of the timer.
local poll_config = nil
-- The interval `start_poll` was given. Needed away from that function because it
-- is also the machine's poll budget, not just this editor's tick spacing.
local poll_interval_ms = nil
local poll_once
local arm_poll

-- The cache key has to change on every write. `mtime.sec` alone does not: a
-- write landing in the same filesystem second as the previous read is
-- invisible, so starting a timer right after a statusline redraw can leave
-- `cached.active` false indefinitely. That used to be a cosmetic lag, but the
-- poll below is now gated on `.active` — a stale "inactive" reading suppresses
-- the very poll that would refresh the file, and nothing recovers it. Include
-- sub-second mtime and size so same-second writes are still observed. Aliasing
-- would need whole-second mtimes *and* an identical file size across the
-- inactive->active transition, which the two JSON payloads never have. If it
-- somehow happened, nothing periodic would clear it — no jcf process rewrites
-- this file on a schedule — so recovery would wait for the user's next jcf
-- command.
local function stat_key(stat)
  return string.format("%d.%09d:%d", stat.mtime.sec, stat.mtime.nsec or 0, stat.size or 0)
end

function M.read(state_path)
  local path = state_path or vim.fn.expand("~/.jcf/state.json")
  local stat = uv.fs_stat(path)
  if not stat then
    -- The file is gone, so whatever we cached describes a world that no longer
    -- exists. Handing back a stale `active` reading would keep the poll below
    -- spawning `jcf timer status` every tick against a timer that isn't there.
    cached = { active = false }
    last_key = nil
    last_path = nil
    return cached
  end
  local key = stat_key(stat)
  if path == last_path and key == last_key then
    return cached
  end
  last_path = path
  last_key = key
  local f = io.open(path, "r")
  if f then
    local content = f:read("*a")
    f:close()
    local ok, data = pcall(vim.json.decode, content)
    if ok and data then
      cached = data
    end
  end
  return cached
end

-- Periodically run `jcf timer status` to sync state file with Clockify
-- This detects externally stopped timers.
--
-- The poll must never stack. `jcf timer status` does network I/O and can hang
-- indefinitely, and one nvim runs per project, so every leaked process is
-- multiplied by the number of open editors. Hence: at most one job in flight,
-- owned by nvim (never detached, so VimLeave and jobstop can actually kill it),
-- under a watchdog. When no timer is running locally there is nothing to
-- reconcile, so the spawn is skipped entirely. That bounds one editor to one
-- poll; the lock below bounds the whole machine to one, which is the part that
-- actually decides the cost when many editors are open.
-- Backstop only. `jcf timer status` bounds every network call it can make, but
-- not all at the same value: an expired Jira token costs up to
-- `REFRESH_TIMEOUT` (30s, in @knpkv/jira-cli's JiraAuth) before any command
-- body runs, then the four Clockify calls cost up to `API_TIMEOUT` (10s each,
-- in src/cli/timer/status.ts). So ~70s of bounded work plus process startup.
-- The watchdog sits well above that — set near it, nvim would be the thing
-- killing a merely slow but healthy poll, and a kill landing inside the state
-- file's write-then-rename leaves a stray `state.json.tmp`. Recompute this
-- from those two constants by name if either changes.
local POLL_TIMEOUT_MS = 120000
-- How long our own SIGTERM gets before we escalate. We signal the pid directly
-- rather than via `jobstop`, because `jobstop` starts nvim's own kill timer and
-- escalates to SIGKILL after about two seconds — far too short for an in-flight
-- OAuth rotation, and not a window we can lengthen.
--
-- Must exceed `REFRESH_TIMEOUT` (30s, in @knpkv/jira-cli's JiraAuth), or we
-- escalate while the very rotation this grace exists for is still legitimately
-- running.
--
-- This is a courtesy, not a guarantee. On `VimLeave` nvim exits immediately and
-- hard-kills surviving jobs, so no grace elapses at all there — a cost of
-- owning the job rather than detaching it, which is what makes it reapable at
-- all. The CLI narrows the damage: it refuses to discard a stored token unless
-- Atlassian explicitly said the grant was invalid, so an interrupted refresh
-- normally costs a retry rather than the session. That is narrowing, not
-- immunity — a hard kill after Atlassian has already rotated the token still
-- loses the replacement, and the next refresh then legitimately reports
-- `invalid_grant`. No client-side design can close that window.
local POLL_STOP_GRACE_MS = 35000

-- ---------------------------------------------------------------------------
-- Cross-editor lock: one `jcf timer status` per machine, not per editor.
-- ---------------------------------------------------------------------------
--
-- The single-flight guard above is process-local. It bounds one nvim to one
-- poll and says nothing about the others, so with an editor open per project it
-- does not bound anything that matters: 19 editors on a 30s timer is 19 cold
-- Node starts every 30s, each making the same four Clockify calls to reconcile
-- the same single global timer.
--
-- The work is inherently shared — one `~/.jcf/state.json`, one running timer —
-- so exactly one editor should do it and the rest should read the file it
-- refreshes, which `M.read` already does off an mtime cache. Coordination uses
-- util-linux `flock`: every editor starts a non-blocking contender, the kernel
-- lets exactly one exec `jcf`, and every loser exits without starting Node.
-- `--no-fork` leaves the lock attached to the `jcf` process itself. If nvim is
-- SIGKILLed, its child therefore keeps the lock until the poll really exits.
--
-- The lock is half of it. It bounds how many polls run *at once*, and because
-- it is released as soon as the CLI exits, it says nothing about how often they
-- run — 19 editors would still spawn ~19 times per interval, just never two at
-- the same moment. The poll stamp below is what bounds the rate, and the two
-- together are what make the "per machine" claim above true.
--
-- No directory is created for it. The lock sits beside the CLI's fixed state
-- authority. Neovim's configurable `state_path` only changes which file the UI
-- reads; `jcf timer status` still mutates `~/.jcf/state.json`, so every editor
-- must coordinate on that one path regardless of its display configuration.
local function cli_state_path()
  return vim.fn.expand("~/.jcf/state.json")
end

local function lock_path()
  return vim.fn.fnamemodify(cli_state_path(), ":h") .. "/poll.lock"
end

-- ---------------------------------------------------------------------------
-- Poll stamp: the lock bounds overlap, this bounds rate.
-- ---------------------------------------------------------------------------
--
-- The lock is held only while `jcf timer status` runs — a second or two — and
-- released the moment it exits. That makes two polls never overlap, which is not
-- the same as making them rare: 19 editors on a 30s timer tick every ~1.6s
-- between them, and by then the lock is free again, so nearly every tick would
-- still spawn. The lock alone therefore delivers ~19 polls per interval, the
-- number it exists to avoid.
--
-- What actually bounds the machine is a record that survives the release. Each
-- finished attempt writes a stamp file before releasing the lock, and a tick
-- that finds the stamp younger than one interval skips. Failed attempts count:
-- otherwise every de-phased editor would retry the same persistent failure in
-- turn. Readers keep the last state file until the next attempt. That is the
-- whole rate limit, and it is what lets the editors stay de-phased without
-- multiplying the work.
--
-- The CLI owns the write so no successor can acquire the lock between process
-- exit and the stamp becoming visible.
local function stamp_path()
  return vim.fn.fnamemodify(cli_state_path(), ":h") .. "/poll.stamp"
end

local function wall_clock_ms()
  local sec, usec = uv.gettimeofday()
  return (sec * 1000) + math.floor(usec / 1000)
end

-- A watchdog escalation bypasses the CLI's Effect finalizers. Write the failed
-- attempt synchronously while the child still owns `poll.lock`, so another
-- editor cannot acquire the lock between SIGKILL and the shared rate bound.
local function stamp_failed_attempt()
  local fd = uv.fs_open(stamp_path(), "w", 384) -- 0600
  if not fd then
    return
  end
  uv.fs_write(fd, tostring(wall_clock_ms()), -1)
  uv.fs_close(fd)
end

-- Whether some editor on this machine already reconciled within the interval.
-- Read from the stamp's own mtime, so a torn or truncated write still carries a
-- usable time and no parsing can fail here.
local function polled_recently()
  if not poll_interval_ms then
    return false
  end
  local stat = uv.fs_stat(stamp_path())
  if not stat then
    return false
  end
  local stamped_at_ms = (stat.mtime.sec * 1000) + math.floor((stat.mtime.nsec or 0) / 1000000)
  local age_ms = wall_clock_ms() - stamped_at_ms
  -- A stamp dated in the future is a clock that moved backwards, not a poll that
  -- has not happened yet; treating it as recent would wedge polling until the
  -- clock caught up.
  if age_ms < 0 then
    return false
  end
  return age_ms < poll_interval_ms
end

local function own_pid()
  if uv.os_getpid then
    return uv.os_getpid()
  end
  return vim.fn.getpid()
end

-- One-shot scheduling keeps this editor's cadence anchored to completion, not
-- start. A repeating timer would tick one interval after start, see the fresh
-- completion stamp, skip, and wait a second whole interval before trying again.
arm_poll = function(delay_ms)
  if not poll_timer or not poll_config then
    return
  end
  poll_timer:stop()
  poll_timer:start(delay_ms, 0, vim.schedule_wrap(function()
    poll_once(poll_config)
  end))
end

-- Ask `job` to stop, then escalate if it does not. Signals the pid directly
-- rather than calling `jobstop`, which starts nvim's own ~2s kill timer and
-- would SIGKILL the CLI long before an in-flight OAuth rotation could finish.
--
-- `flock --no-fork` execs the CLI, so the pid we signal is also the process
-- holding the kernel lock. The lock cannot be released before that process is
-- dead.
local function terminate(job)
  local signalled, pid = pcall(vim.fn.jobpid, job)
  if signalled and pid > 0 then
    uv.kill(pid, "sigterm")
  else
    stamp_failed_attempt()
    vim.fn.jobstop(job) -- no pid to signal; fall back to nvim's own teardown
  end

  vim.defer_fn(function()
    if poll_job ~= job then
      return
    end
    if vim.fn.jobwait({ job }, 0)[1] ~= -1 then
      poll_job = nil -- already exited without `on_exit` reaching us
      arm_poll(poll_interval_ms)
      return
    end
    -- SIGTERM was not enough. Escalate, and let `on_exit` do the releasing.
    local ok, live_pid = pcall(vim.fn.jobpid, job)
    if ok and live_pid > 0 then
      stamp_failed_attempt()
      uv.kill(live_pid, "sigkill")
      return
    end
    -- No pid to escalate against, so nothing further will make this job report.
    -- `jobstop` once more, then release on the next proof rather than wedging
    -- the poll for the rest of the session.
    stamp_failed_attempt()
    vim.fn.jobstop(job)
    vim.defer_fn(function()
      if poll_job == job and vim.fn.jobwait({ job }, 0)[1] ~= -1 then
        poll_job = nil
        arm_poll(poll_interval_ms)
      end
    end, POLL_STOP_GRACE_MS)
  end, POLL_STOP_GRACE_MS)
end

poll_once = function(config)
  if poll_job then
    arm_poll(poll_interval_ms)
    return -- previous poll still in flight; do not stack
  end
  if not M.read(cli_state_path()).active then
    arm_poll(poll_interval_ms)
    return -- no local timer, nothing to reconcile
  end
  if polled_recently() then
    arm_poll(poll_interval_ms)
    return -- someone already reconciled this interval; read their result instead
  end

  -- `job` is declared first so on_exit closes over it, not a global.
  local job
  job = vim.fn.jobstart({
    "flock",
    "--no-fork",
    "--nonblock",
    "--conflict-exit-code",
    "75",
    lock_path(),
    config.binary or "jcf",
    "timer",
    "status",
    "--nvim-poll-stamp",
    stamp_path(),
    "--nvim-poll-interval-ms",
    tostring(poll_interval_ms),
  }, {
    on_stdout = function() end,
    on_stderr = function() end,
    on_exit = function()
      if poll_job == job then
        poll_job = nil
        arm_poll(poll_interval_ms)
      end
    end,
  })
  if job <= 0 then
    arm_poll(poll_interval_ms)
    return -- failed to spawn (`flock` missing); try again next tick
  end
  poll_job = job

  vim.defer_fn(function()
    if poll_job ~= job then
      return
    end
    terminate(job)
  end, POLL_TIMEOUT_MS)
end

function M.start_poll(config, interval_ms)
  if poll_timer then
    return
  end
  interval_ms = interval_ms or 30000 -- 30s default
  if type(interval_ms) ~= "number" or interval_ms <= 0 or interval_ms % 1 ~= 0 then
    return -- non-positive and non-integral values disable polling
  end
  poll_config = config
  poll_interval_ms = interval_ms

  -- Spread the first tick across a whole interval, keyed off the pid, so editors
  -- opened in a batch (a session restore, a fleet of worktrees) do not line up on
  -- the same millisecond forever after. Derived from the pid rather than
  -- `math.random`, which is unseeded per process and would hand every editor the
  -- same offset.
  --
  -- De-phasing is only safe because the stamp bounds the rate. Spreading the
  -- ticks removes the collisions the lock would otherwise resolve, so with the
  -- lock alone this would make things worse, not better: every tick would find
  -- a free lock and spawn.
  local first_ms = own_pid() % interval_ms

  poll_timer = uv.new_timer()
  arm_poll(first_ms)
end

function M.stop_poll()
  if poll_timer then
    poll_timer:stop()
    poll_timer:close()
    poll_timer = nil
  end
  if not poll_job then
    return
  end
  if poll_job then
    -- Exactly the watchdog's sequence, for the same reason: `jobstop` here
    -- would hand the CLI nvim's ~2s kill timer and could SIGKILL it between the
    -- OAuth grant and the rotated token being persisted. Teardown and
    -- reconfiguration deserve the same grace as a timeout. (On `VimLeave` nvim
    -- exits before any of it elapses — the CLI's own retry-not-delete rule is
    -- what covers that case.)
    stamp_failed_attempt()
    terminate(poll_job)
  end
end

return M

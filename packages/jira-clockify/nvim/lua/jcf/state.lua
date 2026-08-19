local M = {}
local uv = vim.loop or vim.uv
local cached = { active = false }
local last_key = nil
local poll_timer = nil
local poll_job = nil

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
    return cached
  end
  local key = stat_key(stat)
  if key == last_key then
    return cached
  end
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
-- reconcile, so the spawn is skipped entirely.
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

-- Ask `job` to stop, then escalate if it does not. Signals the pid directly
-- rather than calling `jobstop`, which starts nvim's own ~2s kill timer and
-- would SIGKILL the CLI long before an in-flight OAuth rotation could finish.
--
-- The guard is never released here: only proof of death releases it, because
-- letting a tick spawn a second poll beside a dying one is the stacking leak
-- this whole mechanism exists to prevent. When in doubt we keep holding, at the
-- cost of no further polling until nvim restarts.
local function terminate(job)
  local signalled, pid = pcall(vim.fn.jobpid, job)
  if signalled and pid > 0 then
    uv.kill(pid, "sigterm")
  else
    vim.fn.jobstop(job) -- no pid to signal; fall back to nvim's own teardown
  end

  vim.defer_fn(function()
    if poll_job ~= job then
      return
    end
    if vim.fn.jobwait({ job }, 0)[1] ~= -1 then
      poll_job = nil -- already exited without `on_exit` reaching us
      return
    end
    -- SIGTERM was not enough. Escalate, and let `on_exit` do the releasing.
    local ok, live_pid = pcall(vim.fn.jobpid, job)
    if ok and live_pid > 0 then
      uv.kill(live_pid, "sigkill")
      return
    end
    -- No pid to escalate against, so nothing further will make this job report.
    -- `jobstop` once more, then release on the next proof rather than wedging
    -- the poll for the rest of the session.
    vim.fn.jobstop(job)
    vim.defer_fn(function()
      if poll_job == job and vim.fn.jobwait({ job }, 0)[1] ~= -1 then
        poll_job = nil
      end
    end, POLL_STOP_GRACE_MS)
  end, POLL_STOP_GRACE_MS)
end

local function poll_once(config)
  if poll_job then
    return -- previous poll still in flight; do not stack
  end
  if not M.read(config.state_path).active then
    return -- no local timer, nothing to reconcile
  end

  -- `job` is declared first so on_exit closes over it, not a global.
  local job
  job = vim.fn.jobstart({ config.binary or "jcf", "timer", "status" }, {
    on_stdout = function() end,
    on_stderr = function() end,
    on_exit = function()
      if poll_job == job then
        poll_job = nil
      end
    end,
  })
  if job <= 0 then
    return -- failed to spawn (missing binary); try again next tick
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

  poll_timer = uv.new_timer()
  poll_timer:start(interval_ms, interval_ms, vim.schedule_wrap(function()
    poll_once(config)
  end))
end

function M.stop_poll()
  if poll_timer then
    poll_timer:stop()
    poll_timer:close()
    poll_timer = nil
  end
  if poll_job then
    -- Exactly the watchdog's sequence, for the same reason: `jobstop` here
    -- would hand the CLI nvim's ~2s kill timer and could SIGKILL it between the
    -- OAuth grant and the rotated token being persisted. Teardown and
    -- reconfiguration deserve the same grace as a timeout. (On `VimLeave` nvim
    -- exits before any of it elapses — the CLI's own retry-not-delete rule is
    -- what covers that case.)
    terminate(poll_job)
  end
end

return M

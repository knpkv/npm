local M = {}
local uv = vim.loop or vim.uv
local cached = { active = false }
local last_key = nil
local poll_timer = nil
local poll_job = nil
-- Config captured by `start_poll`, so teardown paths that get no arguments
-- (`VimLeave` calls `stop_poll()` bare) can still find the lease file.
local poll_config = nil
-- Our nonce in the shared lease, non-nil only while we believe we hold it.
local lease_nonce = nil
-- The interval `start_poll` was given. Needed away from that function because it
-- is also the machine's poll budget, not just this editor's tick spacing.
local poll_interval_ms = nil

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
-- reconcile, so the spawn is skipped entirely. That bounds one editor to one
-- poll; the lease below bounds the whole machine to one, which is the part that
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
-- Cross-editor lease: one `jcf timer status` per machine, not per editor.
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
-- refreshes, which `M.read` already does off an mtime cache. Coordination is a
-- lease file next to the state file, created with `O_EXCL` so the winner is
-- picked by the kernel rather than by a read-then-write race between 19
-- processes. A loser does not queue or retry: it skips the tick, because the
-- winner's poll rewrites the very file the loser reads.
--
-- The lease is half of it. It bounds how many polls run *at once*, and because
-- it is released as soon as the CLI exits, it says nothing about how often they
-- run — 19 editors would still spawn ~19 times per interval, just never two at
-- the same moment. The poll stamp below is what bounds the rate, and the two
-- together are what make the "per machine" claim above true.
--
-- No directory is created for it. The lease sits beside the state file, and we
-- only get here when `M.read` reported an active timer, which means the CLI has
-- already written that file and its directory exists.
-- Derived from the state file rather than hardcoded, and derived with no
-- override: `state_path` is the supported setup option, so a configured state
-- file elsewhere would otherwise leave the lease in a directory nothing creates,
-- and every claim would fail with ENOENT forever.
local function lease_path()
  local state = (poll_config and poll_config.state_path) or vim.fn.expand("~/.jcf/state.json")
  return vim.fn.fnamemodify(state, ":h") .. "/poll.lock"
end

-- ---------------------------------------------------------------------------
-- Poll stamp: the lease bounds overlap, this bounds rate.
-- ---------------------------------------------------------------------------
--
-- The lease is held only while `jcf timer status` runs — a second or two — and
-- released the moment it exits. That makes two polls never overlap, which is not
-- the same as making them rare: 19 editors on a 30s timer tick every ~1.6s
-- between them, and by then the lease is free again, so nearly every tick would
-- still spawn. The lease alone therefore delivers ~19 polls per interval, the
-- number it exists to avoid.
--
-- What actually bounds the machine is a record that survives the release. Each
-- finished poll touches a stamp file beside the lease, and a tick that finds the
-- stamp younger than one interval skips: the reconciliation it would perform has
-- already been performed, and `M.read` will pick the result up off the state
-- file. That is the whole rate limit, and it is what lets the editors stay
-- de-phased without multiplying the work.
--
-- Deliberately its own file rather than a field in the lease. The lease is
-- created with `O_EXCL` and unlinked on release, which is what makes the kernel
-- the arbiter; keeping the stamp elsewhere leaves that exclusive-create path as
-- the ordinary one instead of routing every tick through reclamation.
local function stamp_path()
  local state = (poll_config and poll_config.state_path) or vim.fn.expand("~/.jcf/state.json")
  return vim.fn.fnamemodify(state, ":h") .. "/poll.stamp"
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
  local age_ms = (os.time() - stat.mtime.sec) * 1000
  -- A stamp dated in the future is a clock that moved backwards, not a poll that
  -- has not happened yet; treating it as recent would wedge polling until the
  -- clock caught up.
  if age_ms < 0 then
    return false
  end
  return age_ms < poll_interval_ms
end

-- Record that a poll finished. Best effort throughout: a stamp we fail to write
-- costs one extra poll somewhere, which is the failure this whole mechanism is
-- willing to have.
local function touch_stamp()
  local ok, fd = pcall(uv.fs_open, stamp_path(), "w", 420)
  if not ok or not fd then
    return
  end
  pcall(uv.fs_write, fd, tostring(os.time()), -1)
  pcall(uv.fs_close, fd)
end

-- A lease has to outlive the longest legitimate poll, or an editor would steal
-- from a holder that is still working. The watchdog allows POLL_TIMEOUT_MS, then
-- SIGTERM gets POLL_STOP_GRACE_MS, then the no-pid fallback gets it once more.
-- Anything past that sum is slack for process startup. Recompute from those two
-- constants by name if either moves.
local POLL_LEASE_MS = POLL_TIMEOUT_MS + 2 * POLL_STOP_GRACE_MS + 15000

local function own_pid()
  if uv.os_getpid then
    return uv.os_getpid()
  end
  return vim.fn.getpid()
end

-- Whether `pid` still exists. Signal 0 runs the kernel's existence and
-- permission checks without delivering anything. This is what makes a
-- hard-killed editor's lease reclaimable immediately rather than after the full
-- expiry, and it is the common case: `VimLeave` cannot release anything when
-- nvim is SIGKILLed.
local function pid_alive(pid)
  if type(pid) ~= "number" or pid <= 0 then
    return false
  end
  local ok, result = pcall(uv.kill, pid, 0)
  return ok and result ~= nil
end

-- Returns the parsed lease plus the stat it came from, or nil for either part
-- that could not be obtained. A present-but-unparseable lease (holder died
-- between the create and the write) yields nil data with a real stat, which the
-- caller reads as stale.
local function read_lease(path)
  local stat = uv.fs_stat(path)
  if not stat then
    return nil, nil
  end
  local f = io.open(path, "r")
  if not f then
    return nil, stat
  end
  local content = f:read("*a")
  f:close()
  local ok, data = pcall(vim.json.decode, content)
  if not ok or type(data) ~= "table" then
    return nil, stat
  end
  return data, stat
end

-- Create the lease exclusively. Returns our nonce on success, nil when someone
-- else got there first. A failed write is also nil: without a durable claim on
-- disk we must not poll, since no other editor would be able to see our hold.
local function claim(path)
  local ok, fd = pcall(uv.fs_open, path, "wx", 420)
  if not ok or not fd then
    return nil
  end
  local nonce = string.format("%d-%d", own_pid(), uv.hrtime and uv.hrtime() or 0)
  local payload = vim.json.encode({ pid = own_pid(), at = os.time(), nonce = nonce })
  -- `pcall` only reports whether the call threw; a plain libuv failure returns
  -- `nil, err` without throwing, and a short write returns a smaller count. Both
  -- leave a lease nobody can read, which another editor would reclaim out from
  -- under a poll we thought we owned, so require the full byte count.
  local ok_write, written = pcall(uv.fs_write, fd, payload, -1)
  pcall(uv.fs_close, fd)
  if not ok_write or written ~= #payload then
    pcall(uv.fs_unlink, path)
    return nil
  end
  return nonce
end

-- True when this editor may spawn the poll.
local function acquire_lease()
  local path = lease_path()
  local nonce = claim(path)
  if nonce then
    lease_nonce = nonce
    return true
  end

  local lease, stat = read_lease(path)
  if not stat then
    return false -- vanished between the failed claim and the read; try next tick
  end
  local fresh = lease ~= nil
    and type(lease.at) == "number"
    and (os.time() - lease.at) * 1000 < POLL_LEASE_MS
  if fresh and pid_alive(lease.pid) then
    return false -- somebody is legitimately reconciling right now
  end

  -- Stale: the holder died, or wedged past every deadline it was given.
  -- Requiring the file to be byte-identical to what we just read narrows the
  -- window in which two editors both conclude "stale" and each unlink the
  -- other's fresh claim; the one that observes a changed stat waits a tick
  -- instead. It does not close it — the stat and the unlink are separate calls —
  -- so ownership is confirmed by reading the lease back below. The unlink's own
  -- result is not consulted: if a third party already removed it, that is the
  -- outcome we wanted, and the exclusive create is the only thing that actually
  -- grants ownership.
  local current = uv.fs_stat(path)
  if not current or stat_key(current) ~= stat_key(stat) then
    return false
  end
  pcall(uv.fs_unlink, path)
  nonce = claim(path)
  if not nonce then
    return false
  end
  -- Read back before believing the claim. An editor that reclaimed in the same
  -- window unlinked what we just created and put its own lease there; seeing a
  -- foreign nonce means it is polling, so we skip the tick rather than stack
  -- beside it.
  local claimed = read_lease(path)
  if not claimed or claimed.nonce ~= nonce then
    return false
  end
  lease_nonce = nonce
  return true
end

-- Drop our claim, but only if the file still carries our nonce. A lease we were
-- stolen from belongs to whoever holds it now, and unlinking that would let a
-- third editor in beside them — reintroducing the stacking this prevents.
local function release_lease()
  if not lease_nonce then
    return
  end
  local lease = read_lease(lease_path())
  if lease and lease.nonce == lease_nonce then
    pcall(uv.fs_unlink, lease_path())
  end
  lease_nonce = nil
end

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
      touch_stamp()
      release_lease()
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
        touch_stamp()
        release_lease()
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
  if polled_recently() then
    return -- someone already reconciled this interval; read their result instead
  end
  if not acquire_lease() then
    return -- another editor is reconciling; its write is what we will read
  end

  -- `job` is declared first so on_exit closes over it, not a global.
  local job
  job = vim.fn.jobstart({ config.binary or "jcf", "timer", "status" }, {
    on_stdout = function() end,
    on_stderr = function() end,
    on_exit = function()
      if poll_job == job then
        poll_job = nil
        -- Stamped even when the CLI exited non-zero or was killed by the
        -- watchdog: the point is that this machine just spent a poll on it, and
        -- letting 19 editors each retry a wedged `jcf` immediately is the same
        -- herd by another route.
        touch_stamp()
        release_lease()
      end
    end,
  })
  if job <= 0 then
    -- No stamp: nothing ran, so nothing was reconciled and the next editor to
    -- tick should try rather than assume this interval is covered.
    release_lease() -- holding it would stall every other editor too
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
  poll_config = config
  poll_interval_ms = interval_ms

  -- Spread the first tick across a whole interval, keyed off the pid, so editors
  -- opened in a batch (a session restore, a fleet of worktrees) do not line up on
  -- the same millisecond forever after. Derived from the pid rather than
  -- `math.random`, which is unseeded per process and would hand every editor the
  -- same offset.
  --
  -- De-phasing is only safe because the stamp bounds the rate. Spreading the
  -- ticks removes the collisions the lease would otherwise resolve, so with the
  -- lease alone this would make things worse, not better: every tick would find
  -- a free lease and spawn.
  local first_ms = interval_ms + own_pid() % interval_ms

  poll_timer = uv.new_timer()
  poll_timer:start(first_ms, interval_ms, vim.schedule_wrap(function()
    poll_once(config)
  end))
end

function M.stop_poll()
  if poll_timer then
    poll_timer:stop()
    poll_timer:close()
    poll_timer = nil
  end
  if not poll_job then
    -- Nothing in flight, so nothing has to die before the lease is fair game
    -- for another editor. Hand it back now rather than making them wait out the
    -- expiry.
    release_lease()
    return
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

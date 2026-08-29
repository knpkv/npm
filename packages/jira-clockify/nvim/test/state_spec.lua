-- Specs for nvim/lua/jcf/state.lua, run under `nvim --headless -l`.
--
-- The invariants here are lifecycle ones — "does a second process start while
-- the first is still dying" — so they need controllable time and job control
-- rather than a real `jcf` binary. Everything state.lua touches (`vim.loop`,
-- `vim.fn.job*`, `vim.defer_fn`, `io.open`, `os.time`) is stubbed before the
-- module loads, and the test advances time itself. Exits non-zero on the first
-- failure.
--
-- The lease invariants are cross-process ones, so they need two editors at once.
-- `harness` therefore builds a self-contained world per editor and accepts a
-- shared fake filesystem, and `world.activate()` installs that world's globals —
-- the module captures `vim.loop` at load time but resolves `vim.fn` per call, so
-- whichever world ticked last would otherwise own everyone's job control.

local failures = {}
local checks = 0

local function check(ok, label)
  checks = checks + 1
  if not ok then
    table.insert(failures, label)
  end
end

local function eq(actual, expected, label)
  check(actual == expected, string.format("%s (expected %s, got %s)", label, tostring(expected), tostring(actual)))
end

-- Deliver `on_exit` for the most recently started job. Reports a failure rather
-- than indexing nil, so a regression that prevents the spawn is still legible.
local function fire_exit(world, label)
  if world.handlers == nil or world.handlers.on_exit == nil then
    check(false, label .. " (no job was started, so on_exit could not be delivered)")
    return
  end
  world.complete_job()
  world.handlers.on_exit()
end

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

local MODULE = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/../lua/jcf/state.lua"

local REAL_FN = vim.fn
local REAL_OPEN = io.open
local STATE_PATH = "/fake/state.json"
local LOCK_PATH = "/fake/poll.lock"

-- Any `poll.lock`, not just the configured one, so a spec can assert where an
-- unconfigured lease is derived to rather than only that it exists.
local function is_lease(path)
  return path:sub(-#"poll.lock") == "poll.lock"
end

-- The stamp is the rate bound: the lease says nobody is polling *now*, the stamp
-- says nobody polled *recently*. Both live in the fake filesystem.
local function is_stamp(path)
  return path:sub(-#"poll.stamp") == "poll.stamp"
end

local function is_managed(path)
  return is_lease(path) or is_stamp(path)
end

-- Wall clock shared by every world, because lease freshness is compared across
-- processes. Seconds, like `os.time`, which the module uses for the same reason:
-- the value has to mean the same thing in another editor.
local CLOCK = { s = 1000 }
os.time = function()
  return CLOCK.s
end

local function advance_clock(seconds)
  CLOCK.s = CLOCK.s + seconds
end

-- A fake filesystem holding only the lease file. Passing one table to two
-- harnesses is what makes two editors contend for the same lease. `dead` marks
-- pids that `kill(pid, 0)` should report as gone, standing in for an editor that
-- was SIGKILLed while holding the lease.
local function new_fs()
  return { files = {}, dead = {}, next_key = 0, next_fd = 10, fds = {}, lock_holders = {}, realpaths = {} }
end

-- Builds a fresh world: a fake libuv, fake job control, a deferred-callback
-- queue standing in for real time, and a fresh copy of the module under test.
local function harness(opts)
  local world = {
    now = 0,
    deferred = {},
    jobs_started = 0,
    stopped = {},
    killed = {},
    next_job_id = 100,
    -- what `jobwait` reports: -1 means "still running"
    wait_status = -1,
    timer_starts = {},
    stat = opts.stat,
    content = opts.content,
    handlers = nil,
    pid = opts.pid or 4000,
    fs = opts.fs or new_fs()
  }
  local fs = world.fs

  -- `STATE_PATH` stubs the fixed CLI authority expanded from
  -- `~/.jcf/state.json`; `config.state_path` controls display reads only. The
  -- managed lock and stamp therefore stay beside `STATE_PATH` even when a test
  -- configures another display path.
  world.config = { binary = "jcf", state_path = STATE_PATH }

  local fake_uv = {
    os_getpid = function()
      return world.pid
    end,
    hrtime = function()
      fs.next_key = fs.next_key + 1
      return fs.next_key
    end,
    -- Path-aware: the lease lives in the fake filesystem, everything else is the
    -- single state file the older specs drive through `world.stat`.
    fs_stat = function(path)
      if not is_managed(path) then
        return world.stat
      end
      local entry = fs.files[path]
      if not entry then
        return nil
      end
      -- The stamp's mtime is compared against the wall clock, so it has to be a
      -- real time. The lease's is only ever compared with itself, and uses the
      -- write counter so that two writes in the same second are still distinct —
      -- which is exactly what the stale-reclaim check depends on.
      if is_stamp(path) then
        return { mtime = { sec = entry.at, nsec = 0 }, size = #entry.content }
      end
      return { mtime = { sec = entry.key, nsec = 0 }, size = #entry.content }
    end,
    fs_realpath = function(path)
      return fs.realpaths[path] or path
    end,
    -- Only the exclusive form is used by the module, and it is the whole point:
    -- an existing file must make this fail rather than truncate.
    fs_open = function(path, flags)
      if flags:find("x") and fs.files[path] then
        return nil
      end
      fs.next_key = fs.next_key + 1
      fs.files[path] = { content = "", key = fs.next_key, at = os.time() }
      fs.next_fd = fs.next_fd + 1
      fs.fds[fs.next_fd] = path
      return fs.next_fd
    end,
    fs_write = function(fd, data)
      local path = fs.fds[fd]
      if not path or not fs.files[path] then
        return nil
      end
      fs.files[path].content = data
      return #data
    end,
    fs_close = function(fd)
      fs.fds[fd] = nil
      return true
    end,
    fs_unlink = function(path)
      if not fs.files[path] then
        return nil
      end
      fs.files[path] = nil
      return true
    end,
    -- Signal 0 is a liveness probe, not a kill, so it must not show up in the
    -- assertions about what the watchdog signalled.
    kill = function(pid, signal)
      if signal == 0 then
        -- Spelled out rather than `dead and nil or 0`: in Lua that idiom cannot
        -- yield nil, so every pid would report as alive.
        if fs.dead[pid] then
          return nil
        end
        return 0
      end
      table.insert(world.killed, { pid = pid, signal = signal })
      return 0
    end,
    new_timer = function()
      return {
        start = function(_, initial_ms, repeat_ms, cb)
          table.insert(world.timer_starts, { initial_ms = initial_ms, repeat_ms = repeat_ms })
          world.tick = cb
        end,
        stop = function() end,
        close = function() end
      }
    end
  }

  function world.complete_job()
    if fs.lock_holders[world.poll_lock] ~= world then
      return
    end
    fs.lock_holders[world.poll_lock] = nil
    if fs.lock_holder == world then
      fs.lock_holder = nil
    end
    fs.files[world.poll_stamp] = { content = tostring(os.time()), key = fs.next_key, at = os.time() }
  end

  world.fn = setmetatable({
    expand = function(p)
      return p == "~/.jcf/state.json" and STATE_PATH or p
    end,
    getpid = function()
      return world.pid
    end,
    jobstart = function(command, handlers)
      if command[1] == "flock" then
        if fs.lock_holders[command[6]] then
          return -1
        end
        fs.lock_holders[command[6]] = world
        fs.lock_holder = world
        world.poll_lock = command[6]
        world.poll_stamp = command[11]
        fs.files[command[6]] = fs.files[command[6]] or { content = "", key = fs.next_key, at = os.time() }
      end
      world.jobs_started = world.jobs_started + 1
      world.handlers = handlers
      world.next_job_id = world.next_job_id + 1
      return world.next_job_id
    end,
    jobstop = function(id)
      table.insert(world.stopped, id)
      return 1
    end,
    jobwait = function()
      if world.wait_status ~= -1 and fs.lock_holders[world.poll_lock] == world then
        fs.lock_holders[world.poll_lock] = nil
        if fs.lock_holder == world then
          fs.lock_holder = nil
        end
      end
      return { world.wait_status }
    end,
    jobpid = function(id)
      return id * 10
    end
  }, { __index = REAL_FN })

  world.defer_fn = function(cb, delay)
    table.insert(world.deferred, { at = world.now + delay, cb = cb })
  end

  -- state.lua reads both files itself once the stat says they changed.
  world.io_open = function(path, mode)
    if is_lease(path) then
      local entry = fs.files[path]
      if not entry then
        return nil
      end
      return {
        read = function()
          return entry.content
        end,
        close = function() end
      }
    end
    if world.content == nil then
      return REAL_OPEN(path, mode)
    end
    return {
      read = function()
        return world.content
      end,
      close = function() end
    }
  end

  -- Make this world's globals the live ones. Required before ticking whenever
  -- more than one world exists.
  function world.activate()
    vim.loop = fake_uv
    vim.uv = fake_uv
    vim.fn = world.fn
    vim.defer_fn = world.defer_fn
    io.open = world.io_open
  end

  vim.schedule_wrap = function(cb)
    return cb
  end

  -- Advance time and run every callback that has come due. Moves the shared wall
  -- clock too, so a test that waits out a watchdog also ages the lease.
  function world.advance(ms)
    world.now = world.now + ms
    advance_clock(math.floor(ms / 1000))
    local due = {}
    local pending = {}
    for _, entry in ipairs(world.deferred) do
      if entry.at <= world.now then
        table.insert(due, entry)
      else
        table.insert(pending, entry)
      end
    end
    world.deferred = pending
    for _, entry in ipairs(due) do
      entry.cb()
    end
  end

  world.activate()

  package.loaded["jcf.state"] = nil
  world.state = loadfile(MODULE)()
  return world
end

local ACTIVE = '{"active":true,"ticketKey":"PROJ-1"}'
local INACTIVE = '{"active":false}'

local function statOf(sec, nsec, size)
  return { mtime = { sec = sec, nsec = nsec }, size = size }
end

-- The first reconciliation is spread across one interval, not postponed by a
-- full interval before the jitter. A pid equal to one interval is the boundary:
-- its offset wraps to zero.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, pid = 30000 })
  w.state.start_poll(w.config, 30000)

  local first = w.timer_starts[1]
  eq(first and first.initial_ms, 0, "first poll: jitter stays inside the first interval")
  eq(first and first.repeat_ms, 0, "first poll: timer remains one-shot")
end

-- ---------------------------------------------------------------------------
-- Single-flight: the poll must never stack
-- ---------------------------------------------------------------------------

-- Invalid fixture: SIGTERM is issued but the process never reports exit and
-- still shows as running. The guard must be held, so no second poll starts.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll(w.config, 30000)

  w.tick()
  eq(w.jobs_started, 1, "single-flight: first tick starts a poll")

  w.advance(120000) -- watchdog fires
  eq(#w.killed, 1, "single-flight: watchdog signals the hung job")
  eq(w.killed[1] and w.killed[1].signal, "sigterm", "single-flight: watchdog sends SIGTERM itself")
  eq(#w.stopped, 0, "single-flight: jobstop is not used, so nvim's 2s kill timer never starts")

  w.wait_status = -1 -- still running, and on_exit is withheld
  w.advance(35000) -- grace elapses -> escalate, but do not release the guard
  eq(#w.killed, 2, "single-flight: grace escalates")
  eq(w.killed[2] and w.killed[2].signal, "sigkill", "single-flight: escalation uses SIGKILL")

  w.tick()
  w.advance(30000)
  w.tick()
  eq(w.jobs_started, 1, "single-flight: no second poll while the first is alive")
end

-- Valid fixture: the job reports exit, so a one-shot timer is rearmed from
-- completion. A five-second poll must not make the fixed start-based tick skip
-- and delay the next attempt until two intervals after start.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll(w.config, 30000)

  w.tick()
  eq(w.jobs_started, 1, "exit path: first tick starts a poll")

  advance_clock(5)
  fire_exit(w, "exit path")
  local rearmed = w.timer_starts[#w.timer_starts]
  eq(rearmed.initial_ms, 30000, "exit path: next attempt is one interval after completion")
  eq(rearmed.repeat_ms, 0, "exit path: polling uses a one-shot timer")
  advance_clock(30)
  w.tick()
  eq(w.jobs_started, 2, "exit path: a five-second poll retries by 65 seconds")
end

-- Valid fixture: the process died without on_exit reaching us. Once `jobwait`
-- proves it is gone the guard is released rather than wedging polling forever.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll(w.config, 30000)

  w.tick()
  w.advance(120000)
  w.wait_status = 0 -- exited, we just never heard about it
  w.advance(35000)
  eq(#w.killed, 1, "silent exit: only the watchdog SIGTERM, no escalation")

  advance_clock(30) -- as above: past the stamp, so the guard is what is under test
  w.tick()
  eq(w.jobs_started, 2, "silent exit: proven-dead job releases the guard")
end

-- Teardown takes the same route as the watchdog. Going through `jobstop` would
-- hand the CLI nvim's ~2s kill timer, which can SIGKILL it between the OAuth
-- grant and the rotated token reaching disk.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll(w.config, 30000)
  w.tick()

  w.state.stop_poll()
  eq(#w.stopped, 0, "stop_poll: does not hand the job to nvim's kill timer")
  eq(w.killed[1] and w.killed[1].signal, "sigterm", "stop_poll: asks politely first")

  w.wait_status = -1 -- withhold on_exit; the process is still up
  w.advance(35000 - 1)
  eq(#w.killed, 1, "stop_poll: no escalation before the grace period is up")

  w.advance(1)
  eq(w.killed[2] and w.killed[2].signal, "sigkill", "stop_poll: escalates once grace expires")
end

-- Valid fixture: a job that exits on SIGTERM is never escalated against.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll(w.config, 30000)
  w.tick()

  w.state.stop_poll()
  fire_exit(w, "stop_poll clean exit")
  w.advance(35000)
  eq(#w.killed, 1, "stop_poll: a job that honours SIGTERM is not killed")
end

-- ---------------------------------------------------------------------------
-- Poll gating and the state cache
-- ---------------------------------------------------------------------------

-- No local timer means nothing to reconcile, so no process is spawned at all.
do
  local w = harness({ stat = statOf(10, 0, #INACTIVE), content = INACTIVE })
  w.state.start_poll(w.config, 30000)

  w.tick()
  eq(w.jobs_started, 0, "gating: inactive state skips the spawn")
end

-- The regression: a timer started in the same filesystem second as the last
-- read must still be observed. With a whole-second cache key the poll would
-- stay gated off forever, and nothing would refresh the file to unstick it.
do
  local w = harness({ stat = statOf(10, 0, #INACTIVE), content = INACTIVE })
  w.state.start_poll(w.config, 30000)

  w.tick()
  eq(w.jobs_started, 0, "same-second: starts from an inactive reading")

  -- Same mtime.sec, later nsec, different size — a write within the same second.
  w.stat = statOf(10, 500000000, #ACTIVE)
  w.content = ACTIVE
  w.tick()
  eq(w.jobs_started, 1, "same-second: a sub-second write is still observed")
end

-- A state file that disappears must not leave the last active reading cached:
-- the poll is gated on it, so a stale `active` would spawn a status process
-- every tick for a timer that no longer exists.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll(w.config, 30000)

  w.tick()
  eq(w.jobs_started, 1, "removed file: starts from an active reading")
  fire_exit(w, "removed file") -- release the single-flight guard

  w.stat = nil -- the file is gone
  w.tick()
  eq(w.jobs_started, 1, "removed file: a missing state file stops the polling")
  eq(w.state.read("/fake/state.json").active, false, "removed file: cache reports inactive")
end

-- An unchanged file must still be served from cache — the key must not be so
-- volatile that every read re-parses.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  local first = w.state.read("/fake/state.json")
  w.content = INACTIVE -- content changed but stat did not: cache must win
  local second = w.state.read("/fake/state.json")
  eq(first.active, true, "cache: first read parses the file")
  eq(second.active, true, "cache: an unchanged stat is served from cache")
end

-- ---------------------------------------------------------------------------
-- The cross-editor lock: one poll per machine, not per editor
-- ---------------------------------------------------------------------------

-- Two editors, one shared lease file. Both have an active timer to reconcile and
-- both tick, and exactly one process may result — this is the whole point of the
-- lease, and the regression that had 19 editors spawning 19 `jcf timer status`
-- every 30s.
local function two_editors()
  local fs = new_fs()
  local a = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 4001 })
  local b = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 4002 })
  a.activate()
  a.state.start_poll(a.config, 30000)
  b.activate()
  b.state.start_poll(b.config, 30000)
  return a, b, fs
end

local function tick(world)
  world.activate()
  world.tick()
end

do
  local a, b = two_editors()

  tick(a)
  tick(b)

  eq(a.jobs_started, 1, "lock: the editor that acquires it polls")
  eq(b.jobs_started, 0, "lock: the other editor does not start jcf")
end

-- Losing the lock must not mean losing the statusline: the loser's reading comes
-- from the state file the winner refreshes, so skipping the spawn costs nothing.
do
  local a, b = two_editors()
  tick(a)
  tick(b)
  eq(b.state.read("/fake/state.json").active, true, "lock: a loser still reads the shared state")
end

-- A finished poll hands the lock back, but handing it back is not permission to
-- poll again: the work was just done for the whole machine. This is the pair of
-- checks that separates the two bounds — the lock stops overlap, the stamp
-- stops repetition — and without the second one 19 de-phased editors would each
-- spawn per interval, which is the cost the lock was introduced to remove.
do
  local a, b = two_editors()
  tick(a)
  tick(b)
  eq(b.jobs_started, 0, "handover: blocked while the first poll is in flight")

  a.activate()
  fire_exit(a, "handover")
  tick(b)
  eq(b.jobs_started, 0, "handover: a released lock is still inside the polled interval")

  advance_clock(30)
  tick(b)
  eq(b.jobs_started, 1, "handover: once the interval has passed the next editor takes its turn")
end

-- The rate bound at the scale it exists for. Ten editors, one interval: exactly
-- one poll between them, not one each.
do
  local fs = new_fs()
  local editors = {}
  for i = 1, 10 do
    editors[i] = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 5000 + i })
    editors[i].state.start_poll(editors[i].config, 30000)
  end

  local total = 0
  for _, e in ipairs(editors) do
    tick(e)
    total = total + e.jobs_started
  end
  eq(total, 1, "fleet: ten editors ticking in one interval spawn one poll between them")

  -- The holder finishes; the others still must not pick the work back up.
  for _, e in ipairs(editors) do
    if e.jobs_started == 1 then
      e.activate()
      fire_exit(e, "fleet")
    end
  end
  total = 0
  for _, e in ipairs(editors) do
    tick(e)
    total = total + e.jobs_started
  end
  eq(total, 1, "fleet: a finished poll does not release the rest to poll in the same interval")
end

-- A SIGKILLed editor does not release the lock while its orphaned `jcf` child is
-- still running. Once that child exits it writes the stamp and releases the
-- kernel lock; another editor may run only after the interval passes.
do
  local a, b, fs = two_editors()
  tick(a)
  eq(a.jobs_started, 1, "dead holder: the holder polled")

  fs.dead[4001] = true
  tick(b)
  eq(b.jobs_started, 0, "dead holder: a live orphaned child keeps the lock")

  a.complete_job()
  tick(b)
  eq(b.jobs_started, 0, "dead holder: the child's completion stamp keeps the rate bound")

  advance_clock(30)
  tick(b)
  eq(b.jobs_started, 1, "dead holder: the next editor runs after child exit and one interval")
end

-- Elapsed wall time never licenses stealing a kernel lock from a process that
-- still owns it.
do
  local a, b = two_editors()
  tick(a)

  advance_clock(206)
  tick(b)
  eq(b.jobs_started, 0, "elapsed time: a live lock holder is not stolen from")
end

-- The ordinary case: a fresh lock held by a
-- live editor is never stolen, however often the others tick.
do
  local a, b = two_editors()
  tick(a)

  for _ = 1, 5 do
    tick(b)
  end
  eq(b.jobs_started, 0, "no theft: a fresh lock held by a live editor stands")
end

-- `flock` locks the inode, not the existence of the path. A lock file left from
-- an earlier process is therefore harmless.
do
  local fs = new_fs()
  local b = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 4002 })
  b.state.start_poll(b.config, 30000)
  fs.files[LOCK_PATH] = { content = "", key = 99 }

  tick(b)
  eq(b.jobs_started, 1, "persistent lock file: an unlocked inode is acquired")
end

-- Teardown with nothing in flight leaves no kernel lock behind. The path itself
-- remains, as `flock` expects.
do
  local a, b, fs = two_editors()
  tick(a)
  a.activate()
  fire_exit(a, "teardown") -- poll done, lock already released
  advance_clock(30) -- past the stamp a's poll left, so b is free to claim
  tick(b) -- b acquires it
  eq(b.jobs_started, 1, "teardown: b holds the lock")

  b.activate()
  fire_exit(b, "teardown")
  b.state.stop_poll()
  check(fs.lock_holder == nil, "teardown: stop_poll with no job in flight leaves the lock free")
end

-- A spawn that fails (`flock` missing) must not leave the lock held, or one
-- broken install would silence polling for every editor on the machine.
do
  local fs = new_fs()
  local a = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 4001 })
  a.fn.jobstart = function()
    return -1
  end
  a.state.start_poll(a.config, 30000)

  tick(a)
  check(fs.lock_holder == nil, "failed spawn: the lock is not stranded")
end

-- `state_path` controls what the plugin displays, but `jcf timer status` owns a
-- fixed global state file. Coordination must follow the CLI authority.
do
  local fs = new_fs()
  local a = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 4003 })
  a.state.start_poll({ binary = "jcf", state_path = "/elsewhere/state.json" }, 30000)

  tick(a)
  eq(a.jobs_started, 1, "global lock: a configured display state still polls")
  check(fs.files[LOCK_PATH] ~= nil, "global lock: coordination follows the CLI state authority")
end

-- A display-only state override must not suppress reconciliation of the CLI's
-- fixed active state.
do
  local a = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, pid = 4004 })
  a.state.read = function(path)
    return { active = path == STATE_PATH }
  end
  a.state.start_poll({ binary = "jcf", state_path = "/display/inactive.json" }, 30000)

  tick(a)
  eq(a.jobs_started, 1, "global gate: display state cannot suppress CLI reconciliation")
end

-- Different configured display files still invoke the same CLI state authority,
-- so they must share one machine-wide lock.
do
  local fs = new_fs()
  local a = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 7001 })
  local b = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 7002 })
  a.state.start_poll({ binary = "jcf", state_path = "/state-a/state.json" }, 30000)
  b.state.start_poll({ binary = "jcf", state_path = "/state-b/state.json" }, 30000)

  tick(a)
  tick(b)
  eq(a.jobs_started + b.jobs_started, 1, "global lock: display paths cannot split CLI coordination")
end

-- StateWriter atomically replaces `state.json`; if that file began as a
-- symlink, its realpath changes during the in-flight poll. Lock identity must
-- stay in the fixed CLI directory across that replacement.
do
  local fs = new_fs()
  fs.realpaths[STATE_PATH] = "/symlink-target/state.json"
  local a = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 7201 })
  local b = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE, fs = fs, pid = 7202 })
  a.state.start_poll(a.config, 30000)
  b.state.start_poll(b.config, 30000)

  tick(a)
  fs.realpaths[STATE_PATH] = STATE_PATH -- atomic rename replaced the symlink
  tick(b)
  eq(a.jobs_started + b.jobs_started, 1, "atomic refresh: replacing state.json cannot move the lock")
end

-- ---------------------------------------------------------------------------

if #failures > 0 then
  io.stderr:write(string.format("%d/%d checks failed:\n", #failures, checks))
  for _, f in ipairs(failures) do
    io.stderr:write("  - " .. f .. "\n")
  end
  vim.cmd("cquit 1")
end

io.stdout:write(string.format("ok - %d checks passed\n", checks))
vim.cmd("quit")

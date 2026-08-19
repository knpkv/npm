-- Specs for nvim/lua/jcf/state.lua, run under `nvim --headless -l`.
--
-- The invariants here are lifecycle ones — "does a second process start while
-- the first is still dying" — so they need controllable time and job control
-- rather than a real `jcf` binary. Everything state.lua touches (`vim.loop`,
-- `vim.fn.job*`, `vim.defer_fn`, `io.open`) is stubbed before the module loads,
-- and the test advances time itself. Exits non-zero on the first failure.

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
  world.handlers.on_exit()
end

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

local MODULE = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/../lua/jcf/state.lua"

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
    stat = opts.stat,
    content = opts.content,
    handlers = nil
  }

  local fake_uv = {
    fs_stat = function()
      return world.stat
    end,
    kill = function(pid, signal)
      table.insert(world.killed, { pid = pid, signal = signal })
    end,
    new_timer = function()
      return {
        start = function(_, _, _, cb)
          world.tick = cb
        end,
        stop = function() end,
        close = function() end
      }
    end
  }

  vim.loop = fake_uv
  vim.uv = fake_uv

  vim.fn = setmetatable({
    expand = function(p)
      return p
    end,
    jobstart = function(_, handlers)
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
      return { world.wait_status }
    end,
    jobpid = function(id)
      return id * 10
    end
  }, { __index = vim.fn })

  vim.defer_fn = function(cb, delay)
    table.insert(world.deferred, { at = world.now + delay, cb = cb })
  end

  vim.schedule_wrap = function(cb)
    return cb
  end

  -- state.lua reads the file itself once the stat says it changed.
  local real_open = io.open
  io.open = function(path, mode)
    if world.content == nil then
      return real_open(path, mode)
    end
    return {
      read = function()
        return world.content
      end,
      close = function() end
    }
  end

  -- Advance time and run every callback that has come due.
  function world.advance(ms)
    world.now = world.now + ms
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

  package.loaded["jcf.state"] = nil
  world.state = loadfile(MODULE)()
  return world
end

local ACTIVE = '{"active":true,"ticketKey":"PROJ-1"}'
local INACTIVE = '{"active":false}'

local function statOf(sec, nsec, size)
  return { mtime = { sec = sec, nsec = nsec }, size = size }
end

-- ---------------------------------------------------------------------------
-- Single-flight: the poll must never stack
-- ---------------------------------------------------------------------------

-- Invalid fixture: SIGTERM is issued but the process never reports exit and
-- still shows as running. The guard must be held, so no second poll starts.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll({ binary = "jcf" }, 30000)

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

-- Valid fixture: the job reports exit, so the next tick may poll again.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll({ binary = "jcf" }, 30000)

  w.tick()
  eq(w.jobs_started, 1, "exit path: first tick starts a poll")

  fire_exit(w, "exit path")
  w.tick()
  eq(w.jobs_started, 2, "exit path: a reported exit releases the guard")
end

-- Valid fixture: the process died without on_exit reaching us. Once `jobwait`
-- proves it is gone the guard is released rather than wedging polling forever.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll({ binary = "jcf" }, 30000)

  w.tick()
  w.advance(120000)
  w.wait_status = 0 -- exited, we just never heard about it
  w.advance(35000)
  eq(#w.killed, 1, "silent exit: only the watchdog SIGTERM, no escalation")

  w.tick()
  eq(w.jobs_started, 2, "silent exit: proven-dead job releases the guard")
end

-- Teardown takes the same route as the watchdog. Going through `jobstop` would
-- hand the CLI nvim's ~2s kill timer, which can SIGKILL it between the OAuth
-- grant and the rotated token reaching disk.
do
  local w = harness({ stat = statOf(10, 0, #ACTIVE), content = ACTIVE })
  w.state.start_poll({ binary = "jcf" }, 30000)
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
  w.state.start_poll({ binary = "jcf" }, 30000)
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
  w.state.start_poll({ binary = "jcf" }, 30000)

  w.tick()
  eq(w.jobs_started, 0, "gating: inactive state skips the spawn")
end

-- The regression: a timer started in the same filesystem second as the last
-- read must still be observed. With a whole-second cache key the poll would
-- stay gated off forever, and nothing would refresh the file to unstick it.
do
  local w = harness({ stat = statOf(10, 0, #INACTIVE), content = INACTIVE })
  w.state.start_poll({ binary = "jcf" }, 30000)

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
  w.state.start_poll({ binary = "jcf" }, 30000)

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

if #failures > 0 then
  io.stderr:write(string.format("%d/%d checks failed:\n", #failures, checks))
  for _, f in ipairs(failures) do
    io.stderr:write("  - " .. f .. "\n")
  end
  vim.cmd("cquit 1")
end

io.stdout:write(string.format("ok - %d checks passed\n", checks))
vim.cmd("quit")

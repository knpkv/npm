local M = {}
local uv = vim.loop or vim.uv
local cached = { active = false }
local last_mtime = 0
local poll_timer = nil

function M.read(state_path)
  local path = state_path or vim.fn.expand("~/.jcf/state.json")
  local stat = uv.fs_stat(path)
  if not stat then
    return cached
  end
  if stat.mtime.sec == last_mtime then
    return cached
  end
  last_mtime = stat.mtime.sec
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
-- This detects externally stopped timers
function M.start_poll(config, interval_ms)
  if poll_timer then
    return
  end
  interval_ms = interval_ms or 30000 -- 30s default

  poll_timer = uv.new_timer()
  poll_timer:start(interval_ms, interval_ms, vim.schedule_wrap(function()
    -- jcf timer status updates ~/.jcf/state.json and detects external stops
    vim.fn.jobstart({ config.binary or "jcf", "timer", "status" }, {
      on_stdout = function() end,
      on_stderr = function() end,
      detach = true,
    })
  end))
end

function M.stop_poll()
  if poll_timer then
    poll_timer:stop()
    poll_timer:close()
    poll_timer = nil
  end
end

return M

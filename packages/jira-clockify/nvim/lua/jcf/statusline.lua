local state = require("jcf.state")

local M = {}

function M.status()
  local config = require("jcf").config
  local s = state.read(config.state_path)
  if not s.active then
    return ""
  end
  local started = s.startedAt_unix or 0
  if started == 0 then
    return s.ticketKey or "??"
  end
  local elapsed = s.elapsed or (os.time() - started)
  local h = math.floor(elapsed / 3600)
  local m = math.floor((elapsed % 3600) / 60)
  local sec = elapsed % 60
  local summary = s.summary or ""
  if #summary > 30 then
    summary = summary:sub(1, 30) .. "…"
  end
  return string.format("● %s %s %02d:%02d:%02d", s.ticketKey or "??", summary, h, m, sec)
end

function M.is_active()
  local config = require("jcf").config
  return state.read(config.state_path).active == true
end

return M

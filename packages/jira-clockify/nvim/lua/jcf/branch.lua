local M = {}

local patterns = {
  "^feature/(%u+%-%d+)",
  "^bugfix/(%u+%-%d+)",
  "^hotfix/(%u+%-%d+)",
  "^(%u+%-%d+)/",
  "^(%u+%-%d+)%-",
}

function M.detect()
  local branch = vim.fn.system("git branch --show-current 2>/dev/null"):gsub("%s+", "")
  if branch == "" then
    return nil
  end
  branch = branch:upper()
  for _, pat in ipairs(patterns) do
    local key = branch:match(pat)
    if key then
      return key
    end
  end
  return nil
end

return M

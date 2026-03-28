local M = {}

function M.pick(config)
  local ok, pickers = pcall(require, "telescope.pickers")
  if not ok then
    vim.notify("jcf: telescope.nvim not installed", vim.log.levels.WARN)
    return
  end

  local finders = require("telescope.finders")
  local conf = require("telescope.config").values
  local actions = require("telescope.actions")
  local action_state = require("telescope.actions.state")

  -- Get tickets via jcf list --json
  local result = vim.fn.system({ config.binary, "list", "--json" })
  local tickets_ok, tickets = pcall(vim.json.decode, result)
  if not tickets_ok or not tickets then
    vim.notify("jcf: failed to get tickets", vim.log.levels.ERROR)
    return
  end

  pickers.new({}, {
    prompt_title = "jcf - Select Ticket",
    finder = finders.new_table({
      results = tickets,
      entry_maker = function(entry)
        return {
          value = entry,
          display = string.format("%s  %s  [%s]", entry.key or "?", entry.summary or "", entry.status or ""),
          ordinal = (entry.key or "") .. " " .. (entry.summary or ""),
        }
      end,
    }),
    sorter = conf.generic_sorter({}),
    attach_mappings = function(prompt_bufnr)
      actions.select_default:replace(function()
        actions.close(prompt_bufnr)
        local selection = action_state.get_selected_entry()
        if selection and selection.value and selection.value.key then
          vim.fn.jobstart({ config.binary, "start", selection.value.key }, { detach = true })
          vim.notify("jcf: starting timer on " .. selection.value.key, vim.log.levels.INFO)
        end
      end)
      return true
    end,
  }):find()
end

return M

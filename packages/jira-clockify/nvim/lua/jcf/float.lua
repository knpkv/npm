local M = {}
local win_id = nil
local buf_id = nil

function M.toggle(config)
  if win_id and vim.api.nvim_win_is_valid(win_id) then
    vim.api.nvim_win_close(win_id, true)
    win_id = nil
    buf_id = nil
    return
  end

  local width = math.floor(vim.o.columns * (config.float.width or 0.8))
  local height = math.floor(vim.o.lines * (config.float.height or 0.8))
  local col = math.floor((vim.o.columns - width) / 2)
  local row = math.floor((vim.o.lines - height) / 2)

  buf_id = vim.api.nvim_create_buf(false, true)
  win_id = vim.api.nvim_open_win(buf_id, true, {
    relative = "editor",
    width = width,
    height = height,
    col = col,
    row = row,
    style = "minimal",
    border = "rounded",
    title = " jcf ",
    title_pos = "center",
  })

  vim.fn.termopen(config.binary or "jcf")
  vim.cmd("startinsert")

  -- Close on window leave
  vim.api.nvim_create_autocmd("WinLeave", {
    buffer = buf_id,
    once = true,
    callback = function()
      if win_id and vim.api.nvim_win_is_valid(win_id) then
        vim.api.nvim_win_close(win_id, true)
        win_id = nil
        buf_id = nil
      end
    end,
  })
end

function M.run_command(config, ...)
  local args = { ... }
  local binary = config.binary or "jcf"

  local width = math.floor(vim.o.columns * (config.float.width or 0.8))
  local height = math.floor(vim.o.lines * (config.float.height or 0.8))
  local col = math.floor((vim.o.columns - width) / 2)
  local row = math.floor((vim.o.lines - height) / 2)

  local b = vim.api.nvim_create_buf(false, true)
  local w = vim.api.nvim_open_win(b, true, {
    relative = "editor",
    width = width,
    height = height,
    col = col,
    row = row,
    style = "minimal",
    border = "rounded",
    title = " jcf " .. table.concat(args, " ") .. " ",
    title_pos = "center",
  })

  local cmd_table = { binary, unpack(args) }
  vim.fn.termopen(cmd_table, {
    on_exit = function()
      vim.defer_fn(function()
        if w and vim.api.nvim_win_is_valid(w) then
          vim.api.nvim_win_close(w, true)
        end
      end, 500)
    end,
  })
  vim.cmd("startinsert")
end

function M.is_open()
  return win_id ~= nil and vim.api.nvim_win_is_valid(win_id)
end

return M

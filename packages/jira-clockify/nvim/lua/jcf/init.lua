local M = {}

local defaults = {
  binary = "jcf",
  state_path = vim.fn.expand("~/.jcf/state.json"),
  float = { width = 0.8, height = 0.8 },
  auto_detect_branch = true,
  poll_interval = 30000, -- ms, check Clockify for external changes
}

M.config = defaults

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", defaults, opts or {})

  vim.api.nvim_create_user_command("JcfToggle", function()
    require("jcf.float").toggle(M.config)
  end, { desc = "Toggle jcf floating window" })

  vim.api.nvim_create_user_command("JcfStart", function(args)
    local key = args.args ~= "" and args.args or nil
    if not key and M.config.auto_detect_branch then
      key = require("jcf.branch").detect()
    end
    if key then
      vim.fn.jobstart({ M.config.binary, "start", key }, { detach = true })
      vim.notify("jcf: starting timer on " .. key, vim.log.levels.INFO)
    else
      -- No key and no branch match → open jcf start in float (has built-in fuzzy selector)
      require("jcf.float").run_command(M.config, "start")
    end
  end, { nargs = "?", desc = "Start jcf timer" })

  vim.api.nvim_create_user_command("JcfStop", function()
    -- Open in float so the comment prompt is interactive
    require("jcf.float").run_command(M.config, "stop")
  end, { desc = "Stop jcf timer" })

  vim.api.nvim_create_user_command("JcfDiscard", function()
    require("jcf.float").run_command(M.config, "discard")
  end, { desc = "Discard jcf timer (delete Clockify entry)" })

  vim.api.nvim_create_user_command("JcfLog", function(args)
    local cmd_args = { "log" }
    if args.args ~= "" then
      for word in args.args:gmatch("%S+") do
        table.insert(cmd_args, word)
      end
    end
    require("jcf.float").run_command(M.config, unpack(cmd_args))
  end, { nargs = "*", desc = "Log past work manually" })

  vim.api.nvim_create_user_command("JcfEdit", function()
    require("jcf.float").run_command(M.config, "edit")
  end, { desc = "Edit running timer" })

  vim.api.nvim_create_user_command("JcfStatus", function()
    require("jcf.float").run_command(M.config, "status")
  end, { desc = "Show timer status" })

  -- Start polling for external timer changes
  require("jcf.state").start_poll(M.config, M.config.poll_interval)

  -- Clean up poll timer on exit
  vim.api.nvim_create_autocmd("VimLeave", {
    callback = function() require("jcf.state").stop_poll() end
  })
end

return M

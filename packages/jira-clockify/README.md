# @knpkv/jira-clockify

TUI time tracker bridging Jira and Clockify. Start/stop timers on Jira tickets, auto-log worklogs to both services. Includes Neovim integration.

Built with Effect-TS and [@opentui/react](https://github.com/anomalyco/opentui).

## Installation

```bash
pnpm add @knpkv/jira-clockify
```

Or link globally:

```bash
cd packages/jira-clockify && pnpm link --global
```

## Setup

### 1. Jira OAuth

```bash
jcf auth jira create      # Opens Atlassian console — create OAuth 2.0 app
jcf auth jira configure    # Set client ID and secret
jcf auth jira login        # Authenticate via browser
```

### 2. Clockify API Key

```bash
jcf auth clockify setup    # Enter API key from https://app.clockify.me/manage-api-keys
```

### 3. Configure Defaults

```bash
jcf config set project     # Select default Clockify project
jcf config set billable    # Set default billable flag
jcf config set jql <jql>   # Set default JQL filter
jcf config show            # Show current config
jcf config reset           # Reset to defaults
```

## CLI Commands

```bash
jcf                        # Launch TUI (or guided setup if not configured)
jcf tui                    # Launch TUI explicitly
jcf start [ISSUE-KEY]      # Start timer on a Jira ticket
jcf stop                   # Stop timer, log to Clockify + Jira
jcf discard                # Discard timer (delete Clockify entry, no Jira worklog)
jcf log                    # Log past work manually
jcf edit                   # Edit running timer
jcf status                 # Show current timer status
jcf list [--json]          # List Jira tickets from configured JQL
jcf auth status            # Show auth status for both services
```

## TUI Keybindings

| Key           | Action                           |
| ------------- | -------------------------------- |
| `j` / `k`     | Navigate ticket list             |
| `s` / `Enter` | Start timer on selected ticket   |
| `x`           | Stop timer (with comment prompt) |
| `d`           | Discard timer                    |
| `l` / `Tab`   | Toggle between timer and tickets |
| `/` / `f`     | Filter tickets                   |
| `r`           | Refresh ticket list              |
| `q`           | Quit                             |
| `Ctrl+C`      | Force quit                       |

## Neovim Plugin

Ships with a Lua plugin in `nvim/lua/jcf/`. Auto-detects Jira issue keys from branch names.

### lazy.nvim

```lua
{
  dir = "path/to/packages/jira-clockify",
  config = function()
    require("jcf").setup({
      binary = "jcf",                -- path to jcf binary
      auto_detect_branch = true,     -- detect issue key from git branch
      float = { width = 0.8, height = 0.8 },
      poll_interval = 30000,         -- ms, poll Clockify for external changes
    })
  end,
}
```

### Neovim Commands

| Command       | Description                                         |
| ------------- | --------------------------------------------------- |
| `:JcfToggle`  | Toggle jcf floating terminal                        |
| `:JcfStart`   | Start timer (auto-detects branch or opens selector) |
| `:JcfStop`    | Stop timer (opens float for comment)                |
| `:JcfDiscard` | Discard timer                                       |
| `:JcfLog`     | Log past work                                       |
| `:JcfEdit`    | Edit running timer                                  |
| `:JcfStatus`  | Show timer status                                   |

## Config

Stored in `~/.jcf/`:

```
~/.jcf/
├── config.json      # JQL, project, billable defaults
├── clockify.json    # Clockify API key, workspace, user
└── state.json       # Current timer state
```

Jira OAuth credentials stored via `@knpkv/atlassian-common` in `~/.config/atlassian/`.

## License

MIT

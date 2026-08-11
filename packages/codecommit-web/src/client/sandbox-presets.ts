export interface SandboxVolumeMount {
  readonly hostPath: string
  readonly containerPath: string
  readonly readonly: boolean
}

export const sandboxRuntimeXdgDataHome = "/tmp/.local/share"

export const COMMAND_PRESETS: ReadonlyArray<{ readonly label: string; readonly cmd: string }> = [
  {
    label: "Node 22",
    cmd:
      "export NVM_DIR=\"$HOME/.nvm\" && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | sh && . \"$NVM_DIR/nvm.sh\" && nvm install 22"
  },
  {
    label: "pnpm",
    cmd:
      "npm install --global --prefix \"$HOME/.local\" pnpm && echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> \"$HOME/.profile\""
  },
  {
    label: "Bun",
    cmd:
      "curl -fsSL https://bun.sh/install | bash && echo 'export PATH=\"$HOME/.bun/bin:$PATH\"' >> ~/.bashrc && echo 'export PATH=\"$HOME/.bun/bin:$PATH\"' >> ~/.profile"
  }
]

export const MOUNT_PRESETS: ReadonlyArray<{
  readonly label: string
  readonly mount: SandboxVolumeMount
}> = [
  {
    label: "VS Code Extensions",
    mount: {
      hostPath: "~/.codecommit/sandbox-volumes/extensions",
      containerPath: `${sandboxRuntimeXdgDataHome}/code-server/extensions`,
      readonly: false
    }
  },
  {
    label: "VS Code Settings",
    mount: {
      hostPath: "~/.codecommit/sandbox-volumes/settings.json",
      containerPath: `${sandboxRuntimeXdgDataHome}/code-server/User/settings.json`,
      readonly: true
    }
  },
  {
    label: "VS Code Keybindings",
    mount: {
      hostPath: "~/.codecommit/sandbox-volumes/keybindings.json",
      containerPath: `${sandboxRuntimeXdgDataHome}/code-server/User/keybindings.json`,
      readonly: true
    }
  }
]

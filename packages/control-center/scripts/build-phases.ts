export type BuildPhase = {
  readonly args: ReadonlyArray<string>
  readonly command: string
  readonly label: string
}

/** The ordered, integrity-preserving phases of a Control Center production build. */
export const controlCenterBuildPhases: ReadonlyArray<BuildPhase> = [
  {
    args: ["scripts/ensure-build-dependencies.ts"],
    command: "tsx",
    label: "ensure dependency artifacts"
  },
  {
    args: ["scripts/validate-boundaries.ts"],
    command: "tsx",
    label: "validate source boundaries"
  },
  {
    args: ["dist", "node_modules/.cache/tsconfig.server.tsbuildinfo", "node_modules/.cache/tsconfig.views.tsbuildinfo"],
    command: "rimraf",
    label: "clean output"
  },
  {
    args: ["build", "--mode", "client"],
    command: "vite",
    label: "bundle client"
  },
  {
    args: ["build", "--mode", "server"],
    command: "vite",
    label: "bundle server"
  },
  {
    args: ["-b", "tsconfig.server.json"],
    command: "tsc",
    label: "emit server declarations"
  },
  {
    args: ["build", "--config", "vite.views.config.ts"],
    command: "vite",
    label: "bundle views"
  },
  {
    args: ["-b", "tsconfig.views.json"],
    command: "tsc",
    label: "emit views declarations"
  },
  {
    args: ["scripts/validate-dist.ts"],
    command: "tsx",
    label: "validate distribution integrity"
  }
]

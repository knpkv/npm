export type BuildPhase = {
  readonly args: ReadonlyArray<string>
  readonly command: string
  readonly label: string
}

/** The ordered, integrity-preserving phases of a Control Center production build. */
export const controlCenterBuildPhases: ReadonlyArray<BuildPhase> = [
  {
    args: ["scripts/validate-boundaries.ts"],
    command: "tsx",
    label: "validate source boundaries"
  },
  {
    args: ["dist", "node_modules/.cache/tsconfig.server.tsbuildinfo"],
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
    args: ["scripts/validate-dist.ts"],
    command: "tsx",
    label: "validate distribution integrity"
  }
]

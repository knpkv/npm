/** Supported top-level CLI invocation after Node removes executable and script arguments. */
export type ControlCenterCliInvocation =
  | { readonly _tag: "serve" }
  | { readonly _tag: "recover-owner" }
  | { readonly _tag: "backup"; readonly archiveRoot: string }
  | { readonly _tag: "verify-backup"; readonly archiveRoot: string }
  | { readonly _tag: "restore"; readonly archiveRoot: string }
  | { readonly _tag: "invalid"; readonly command: string }

/** Classify the exact supported CLI argument shapes without accepting trailing arguments. */
export const classifyControlCenterCliArguments = (
  arguments_: ReadonlyArray<string>
): ControlCenterCliInvocation => {
  if (arguments_.length === 0) return { _tag: "serve" }
  if (arguments_.length === 1 && arguments_[0] === "recover-owner") {
    return { _tag: "recover-owner" }
  }
  const archiveRoot = arguments_[1]
  if (arguments_.length === 2 && archiveRoot !== undefined && archiveRoot !== "") {
    if (arguments_[0] === "backup") return { _tag: "backup", archiveRoot }
    if (arguments_[0] === "verify-backup") {
      return { _tag: "verify-backup", archiveRoot }
    }
    if (arguments_[0] === "restore") return { _tag: "restore", archiveRoot }
  }
  return { _tag: "invalid", command: arguments_.join(" ") }
}

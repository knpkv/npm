/** Supported top-level CLI invocation after Node removes executable and script arguments. */
export type ControlCenterCliInvocation =
  | { readonly _tag: "serve" }
  | { readonly _tag: "recover-owner" }
  | { readonly _tag: "invalid"; readonly command: string }

/** Classify the exact supported CLI argument shapes without accepting trailing arguments. */
export const classifyControlCenterCliArguments = (
  arguments_: ReadonlyArray<string>
): ControlCenterCliInvocation => {
  if (arguments_.length === 0) return { _tag: "serve" }
  if (arguments_.length === 1 && arguments_[0] === "recover-owner") {
    return { _tag: "recover-owner" }
  }
  return { _tag: "invalid", command: arguments_.join(" ") }
}

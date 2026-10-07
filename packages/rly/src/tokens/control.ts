/**
 * One shared block size per control size, so a Button, Select, IconButton and field control in the
 * same toolbar line up. `dense` is tool density; coarse pointers raise small sizes to a 44px target.
 */
export interface ControlHeightTokenSource {
  readonly name: string
  readonly value: string
  readonly coarse: string
}

const defineControlHeights = <const Tokens extends ReadonlyArray<ControlHeightTokenSource>>(tokens: Tokens): Tokens =>
  tokens

export const controlHeightTokenSource = defineControlHeights([
  { name: "dense", value: "32px", coarse: "44px" },
  { name: "compact", value: "40px", coarse: "44px" },
  { name: "default", value: "48px", coarse: "48px" },
  { name: "principal", value: "56px", coarse: "56px" }
])

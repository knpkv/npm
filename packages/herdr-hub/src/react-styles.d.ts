import "react"

declare module "react" {
  interface CSSProperties {
    readonly "--pull-distance"?: string
  }
}

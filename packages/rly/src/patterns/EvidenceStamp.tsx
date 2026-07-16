import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { FreshnessStamp, type RlyFreshnessState } from "./FreshnessStamp.js"
import { ServiceMark, type RlyService } from "./ServiceMark.js"
import styles from "./EvidenceStamp.module.css"

const style = (name: string): string => cssClass(styles, name)

type EvidenceFreshnessTimeProps =
  | { readonly freshnessDateTime: string; readonly freshnessTime: string }
  | { readonly freshnessDateTime?: never; readonly freshnessTime?: never }

/** Props for immutable evidence identity with separately represented source and freshness. */
export type EvidenceStampProps = Omit<ComponentPropsWithRef<"div">, "children"> &
  EvidenceFreshnessTimeProps & {
    readonly freshness: RlyFreshnessState
    readonly reference: string
    readonly service: RlyService
  }

/** Render evidence provenance and supplied freshness as separate, readable concepts. */
export const EvidenceStamp = ({
  className,
  freshness,
  freshnessDateTime,
  freshnessTime,
  reference,
  service,
  ...props
}: EvidenceStampProps): ReactElement => {
  const visibleReference = requireText(reference, "EvidenceStamp reference")
  const freshnessStamp =
    freshnessDateTime === undefined || freshnessTime === undefined ? (
      <FreshnessStamp size="compact" state={freshness} />
    ) : (
      <FreshnessStamp dateTime={freshnessDateTime} size="compact" state={freshness} time={freshnessTime} />
    )

  return (
    <div {...props} className={classNames(style("root"), className)} data-rly-evidence-stamp="">
      <div className={style("source")} data-rly-evidence-source={service}>
        <span className={style("conceptLabel")}>Evidence source</span>
        <div className={style("sourceDetail")}>
          <ServiceMark service={service} size="compact" />
          <code className={style("reference")}>{visibleReference}</code>
        </div>
      </div>
      <div className={style("freshness")} data-rly-evidence-freshness={freshness}>
        <span className={style("conceptLabel")}>Freshness</span>
        {freshnessStamp}
      </div>
    </div>
  )
}

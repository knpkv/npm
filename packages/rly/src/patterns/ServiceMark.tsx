import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, defineVariants } from "../internal/component.js"
import styles from "./ServiceMark.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable provider and density choices for ServiceMark. */
export const RLY_SERVICE_MARK_VARIANTS = defineVariants({
  service: {
    codecommit: {
      className: style("codecommit"),
      purpose: "CodeCommit provenance",
      tokens: ["color-service-codecommit"]
    },
    codepipeline: {
      className: style("codepipeline"),
      purpose: "CodePipeline provenance",
      tokens: ["color-service-codepipeline"]
    },
    jira: { className: style("jira"), purpose: "Jira provenance", tokens: ["color-service-jira"] },
    confluence: {
      className: style("confluence"),
      purpose: "Confluence provenance",
      tokens: ["color-service-confluence"]
    },
    clockify: {
      className: style("clockify"),
      purpose: "Clockify provenance",
      tokens: ["color-service-clockify"]
    }
  },
  size: {
    compact: { className: style("compact"), purpose: "Dense provenance metadata", tokens: ["space-24", "type-meta"] },
    default: {
      className: style("defaultSize"),
      purpose: "Standard provenance identity",
      tokens: ["space-32", "type-label"]
    }
  }
})

/** Default ServiceMark density. A service is always supplied explicitly. */
export const RLY_SERVICE_MARK_DEFAULT_VARIANTS = defineVariants({ size: "default" })

/** Service identities supported by rly provenance patterns. */
export type RlyService = keyof typeof RLY_SERVICE_MARK_VARIANTS.service

/** Visual density supported by ServiceMark. */
export type RlyServiceMarkSize = keyof typeof RLY_SERVICE_MARK_VARIANTS.size

const serviceNames: Readonly<Record<RlyService, string>> = {
  codecommit: "CodeCommit",
  codepipeline: "CodePipeline",
  jira: "Jira",
  confluence: "Confluence",
  clockify: "Clockify"
}

const CodeCommitGlyph = (): ReactElement => (
  <svg aria-hidden="true" className={style("glyph")} focusable="false" viewBox="0 0 24 24">
    <path d="M6 5.5h7.5a3 3 0 0 1 3 3v7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    <circle cx="6" cy="5.5" fill="currentColor" r="2" />
    <circle cx="16.5" cy="17.5" fill="currentColor" r="2" />
    <path d="m10 12 2-2 2 2-2 2Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
  </svg>
)

const CodePipelineGlyph = (): ReactElement => (
  <svg aria-hidden="true" className={style("glyph")} focusable="false" viewBox="0 0 24 24">
    <rect fill="none" height="5" rx="1" stroke="currentColor" strokeWidth="1.7" width="5" x="2.5" y="9.5" />
    <rect fill="none" height="5" rx="1" stroke="currentColor" strokeWidth="1.7" width="5" x="16.5" y="9.5" />
    <path
      d="M8 12h7m-2.5-2.5L15 12l-2.5 2.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  </svg>
)

const JiraGlyph = (): ReactElement => (
  <svg aria-hidden="true" className={style("glyph")} focusable="false" viewBox="0 0 24 24">
    <path d="m12 2.8 8.8 8.8a.6.6 0 0 1 0 .8L12 21.2l-8.8-8.8a.6.6 0 0 1 0-.8Z" fill="currentColor" />
    <path d="m12 7.2 4.8 4.8-4.8 4.8L7.2 12Z" fill="var(--rly-color-surface-1)" />
    <path d="m12 9.8 2.2 2.2-2.2 2.2L9.8 12Z" fill="currentColor" />
  </svg>
)

const ConfluenceGlyph = (): ReactElement => (
  <svg aria-hidden="true" className={style("glyph")} focusable="false" viewBox="0 0 24 24">
    <path d="M4 7.2c3.6 2.1 6.8 2.4 9.6.9L17 6.3l2.7 4.3-3.4 1.8c-4.6 2.4-9.5 1.8-14-1.5Z" fill="currentColor" />
    <path d="M20 16.8c-3.6-2.1-6.8-2.4-9.6-.9L7 17.7l-2.7-4.3 3.4-1.8c4.6-2.4 9.5-1.8 14 1.5Z" fill="currentColor" />
  </svg>
)

const ClockifyGlyph = (): ReactElement => (
  <svg aria-hidden="true" className={style("glyph")} focusable="false" viewBox="0 0 24 24">
    <circle cx="11" cy="13" fill="none" r="7" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M11 9v4l3 2m1.5-10.7 1.8-1.8M18 7l2-2"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  </svg>
)

type ServiceGlyph = () => ReactElement
const serviceGlyphs = {
  codecommit: CodeCommitGlyph,
  codepipeline: CodePipelineGlyph,
  jira: JiraGlyph,
  confluence: ConfluenceGlyph,
  clockify: ClockifyGlyph
} satisfies Readonly<Record<RlyService, ServiceGlyph>>

/** Props for a fully named, code-owned service identity mark. */
export type ServiceMarkProps = Omit<ComponentPropsWithRef<"span">, "aria-label" | "children" | "role"> & {
  readonly service: RlyService
  readonly size?: RlyServiceMarkSize
}

/** Render recognizable service provenance with a full visible and accessible provider name. */
export const ServiceMark = ({ className, service, size = "default", ...props }: ServiceMarkProps): ReactElement => {
  const Glyph = serviceGlyphs[service]
  const name = serviceNames[service]
  return (
    <span
      {...props}
      aria-label={name}
      className={classNames(
        style("root"),
        RLY_SERVICE_MARK_VARIANTS.service[service].className,
        RLY_SERVICE_MARK_VARIANTS.size[size].className,
        className
      )}
      data-rly-service={service}
      role="img"
    >
      <span aria-hidden="true" className={style("rail")} />
      <Glyph />
      <span aria-hidden="true" className={style("name")}>
        {name}
      </span>
    </span>
  )
}

import { Fragment, type AriaAttributes, type ComponentPropsWithRef, type ReactElement, useId } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Field.module.css"

const style = (name: string): string => cssClass(styles, name)
const semanticControlKeys: ReadonlyArray<keyof FieldControlProps> = [
  "aria-describedby",
  "aria-errormessage",
  "aria-invalid",
  "aria-labelledby",
  "aria-required",
  "id",
  "required"
]

export const RLY_FIELD_VARIANTS = defineVariants({
  size: {
    compact: { className: style("compact"), purpose: "Dense form rows", tokens: ["space-40", "type-meta"] },
    default: { className: style("defaultSize"), purpose: "Standard form controls", tokens: ["space-48", "type-label"] }
  }
})

export const RLY_FIELD_DEFAULT_VARIANTS = defineVariants({ size: "default" })
export type RlyFieldSize = keyof typeof RLY_FIELD_VARIANTS.size

/** DOM-neutral semantics to spread onto an input, textarea, native select, or rly Select. */
export interface FieldControlProps {
  readonly "aria-describedby"?: AriaAttributes["aria-describedby"]
  readonly "aria-errormessage"?: AriaAttributes["aria-errormessage"]
  readonly "aria-invalid"?: AriaAttributes["aria-invalid"]
  readonly "aria-labelledby": string
  readonly "aria-required"?: AriaAttributes["aria-required"]
  readonly className: string
  readonly id: string
  readonly required?: true
}

export type FieldProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  readonly children: (controlProps: FieldControlProps) => ReactElement<FieldControlProps>
  readonly controlId?: string
  readonly description?: string
  readonly error?: string
  readonly label: string
  readonly required?: boolean
  readonly size?: RlyFieldSize
}

/** Compose visible field context with control semantics without cloning an implementation-specific control. */
export const Field = ({
  children,
  className,
  controlId,
  description,
  error,
  label,
  required = false,
  size = RLY_FIELD_DEFAULT_VARIANTS.size,
  ...props
}: FieldProps): ReactElement => {
  const generatedId = useId()
  const resolvedControlId = controlId ?? `rly-field-${generatedId}`
  const labelId = `${resolvedControlId}-label`
  const descriptionId = description === undefined ? undefined : `${resolvedControlId}-description`
  const errorId = error === undefined ? undefined : `${resolvedControlId}-error`
  const describedBy = [descriptionId, errorId].filter((id): id is string => id !== undefined).join(" ") || undefined
  const commonControlProps: FieldControlProps = {
    "aria-describedby": describedBy,
    "aria-errormessage": errorId,
    "aria-invalid": error === undefined ? undefined : true,
    "aria-labelledby": labelId,
    "aria-required": required ? true : undefined,
    className: style("control"),
    id: resolvedControlId
  }
  const controlProps: FieldControlProps = required ? { ...commonControlProps, required: true } : commonControlProps
  const control = children(controlProps)
  if (control.type === Fragment) throw new Error("Field children must render one control")
  for (const key of semanticControlKeys) {
    if (control.props[key] !== controlProps[key]) throw new Error(`Field control must apply ${key}`)
  }
  if (!control.props.className.split(" ").includes(controlProps.className)) {
    throw new Error("Field control must apply className")
  }

  return (
    <div
      {...props}
      className={classNames(style("root"), RLY_FIELD_VARIANTS.size[size].className, className)}
      data-error={error === undefined ? undefined : "true"}
    >
      <label className={style("label")} htmlFor={resolvedControlId} id={labelId}>
        {requireText(label, "Field label")}
        {required ? <span className={style("required")}>Required</span> : null}
      </label>
      {description === undefined ? null : (
        <p className={style("description")} id={descriptionId}>
          {requireText(description, "Field description")}
        </p>
      )}
      <div className={style("controlSlot")}>{control}</div>
      {error === undefined ? null : (
        <p className={style("error")} id={errorId} role="alert">
          {requireText(error, "Field error")}
        </p>
      )}
    </div>
  )
}

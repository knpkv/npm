import { Surface } from "@knpkv/rly/primitives"
import { ChevronDownIcon } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import styles from "./pr-detail.module.css"

export function CollapsibleSection({
  children,
  count,
  keepMounted = false,
  openRequestKey,
  title
}: {
  readonly title: string
  readonly count?: number
  readonly keepMounted?: boolean
  readonly openRequestKey?: string
  readonly children: (open: boolean) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (openRequestKey !== undefined) setOpen(true)
  }, [openRequestKey])
  const content = children(open)
  return (
    <Surface as="section" className={styles.disclosure} padding="none" form="grouped">
      <button aria-expanded={open} className={styles.disclosureTrigger} onClick={() => setOpen(!open)} type="button">
        <ChevronDownIcon aria-hidden="true" className={styles.disclosureIcon} data-open={open ? "true" : "false"} />
        <span>{title}</span>
        {count !== undefined && <small>{count}</small>}
      </button>
      {(open || keepMounted) && (
        <div className={styles.disclosureContent} hidden={!open}>
          {content}
        </div>
      )}
    </Surface>
  )
}

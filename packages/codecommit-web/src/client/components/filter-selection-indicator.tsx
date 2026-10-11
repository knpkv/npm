import { CheckIcon } from "lucide-react"
import styles from "./review-queue.module.css"

export interface FilterSelectionIndicatorProps {
  readonly selected: boolean
}

export function FilterSelectionIndicator({ selected }: FilterSelectionIndicatorProps) {
  return (
    <>
      <span aria-hidden="true" className={styles.optionCheck} data-selected={selected ? "true" : undefined}>
        {selected ? <CheckIcon /> : null}
      </span>
      <span className={styles.visuallyHidden}>{selected ? "Selected" : "Not selected"}</span>
    </>
  )
}

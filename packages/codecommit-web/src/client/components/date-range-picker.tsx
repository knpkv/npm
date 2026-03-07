import { CalendarIcon, XIcon } from "lucide-react"
import { useEffect, useState } from "react"
import type { DateRange } from "react-day-picker"
import { Button } from "./ui/button.js"
import { Calendar } from "./ui/calendar.js"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js"

function toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function formatShort(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function DateRangePicker({
  from,
  onChange,
  to
}: {
  from: string | undefined
  to: string | undefined
  onChange: (from: string | undefined, to: string | undefined) => void
}) {
  const fromDate = from ? new Date(from + "T00:00:00") : undefined
  const toDate = to ? new Date(to + "T00:00:00") : undefined
  const hasRange = !!from || !!to

  const [range, setRange] = useState<DateRange | undefined>(
    fromDate || toDate ? { from: fromDate, to: toDate } : undefined
  )

  // Sync internal state when URL params change externally (e.g. "Clear" button)
  useEffect(() => {
    setRange(fromDate || toDate ? { from: fromDate, to: toDate } : undefined)
  }, [from, to])

  const handleSelect = (r: DateRange | undefined) => {
    setRange(r)
    if (r?.from && r?.to) {
      onChange(toDateStr(r.from), toDateStr(r.to))
    } else if (r?.from) {
      onChange(toDateStr(r.from), undefined)
    } else {
      onChange(undefined, undefined)
    }
  }

  const label = hasRange
    ? `${fromDate ? formatShort(fromDate) : "…"} – ${toDate ? formatShort(toDate) : "…"}`
    : "Date range"

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={hasRange ? "secondary" : "outline"} size="sm" className="gap-1 h-7 text-xs">
          <CalendarIcon className="size-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar
          mode="range"
          selected={range}
          onSelect={handleSelect}
          numberOfMonths={1}
          {...(fromDate ? { defaultMonth: fromDate } : {})}
        />
        {hasRange && (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-7 text-xs gap-1"
              onClick={() => {
                setRange(undefined)
                onChange(undefined, undefined)
              }}
            >
              <XIcon className="size-3" />
              Clear dates
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

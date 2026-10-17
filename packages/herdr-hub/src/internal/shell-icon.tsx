import type { ReactElement } from "react"

const paths = {
  connect: "m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10",
  code: "M7 3v12a4 4 0 0 0 4 4h3M17 7v8M7 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4M17 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4M17 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  fleet:
    "M7 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6M1 22v-3a5 5 0 0 1 10 0v3M14 16a4 4 0 0 1 8 2v4",
  modules: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  resources: "M6 6h12v12H6zM10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4",
  stacks: "m12 2 10 5-10 5L2 7l10-5M2 12l10 5 10-5M2 17l10 5 10-5",
  usage: "M4 20V12M10 20V4M16 20V8M22 20H2",
  next: "m9 6 6 6-6 6",
  notifications: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  host: "m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5l8-3M8 11l3 3 5-6"
}

/** Shell-only decorative glyphs; the surrounding control owns the accessible name. */
export const ShellIcon = ({ name }: { readonly name: keyof typeof paths }): ReactElement => (
  <svg
    aria-hidden="true"
    className="superapp-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={paths[name]} />
  </svg>
)

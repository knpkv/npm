import { useId, type ReactElement } from "react"

/** Static approved mark. Gradient ids belong to this instance, including when another copy is hidden. */
export const RelayChefMark = (): ReactElement => {
  const seed = useId()
  const body = `${seed}-body`
  const gloss = `${seed}-gloss`
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="relay-chef-mark"
      viewBox="0 0 32 32"
      width={32}
      height={32}
      fill="none"
    >
      <g data-relay-chef-drawing="mark">
        <defs>
          <radialGradient id={body} gradientUnits="userSpaceOnUse" cx="11" cy="13" r="19">
            <stop offset="0" stopColor="#f2b4df" />
            <stop offset="0.45" stopColor="#b654b0" />
            <stop offset="1" stopColor="#8f3a93" />
          </radialGradient>
          <radialGradient id={gloss}>
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.6" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path
          d="M28 17.982C27.994 19.015 27.822 20.057 27.569 21.045C27.317 22.032 26.945 22.991 26.485 23.906C26.025 24.821 25.478 25.718 24.81 26.535C24.142 27.351 23.367 28.159 22.477 28.805C21.586 29.451 20.545 30.046 19.465 30.412C18.386 30.777 17.155 31 16 31C14.845 31 13.614 30.777 12.535 30.412C11.455 30.046 10.414 29.451 9.523 28.805C8.633 28.159 7.858 27.351 7.19 26.535C6.522 25.718 5.975 24.821 5.515 23.906C5.055 22.991 4.683 22.032 4.431 21.045C4.178 20.057 4.006 19.015 4 17.982C3.994 16.949 4.11 15.853 4.397 14.846C4.684 13.838 5.147 12.81 5.723 11.938C6.298 11.065 7.06 10.255 7.849 9.609C8.639 8.962 9.562 8.451 10.459 8.057C11.355 7.662 12.305 7.418 13.229 7.242C14.152 7.066 15.076 7 16 7C16.924 7 17.848 7.066 18.771 7.242C19.695 7.418 20.645 7.662 21.541 8.057C22.438 8.451 23.361 8.962 24.151 9.609C24.94 10.255 25.702 11.065 26.277 11.938C26.853 12.81 27.316 13.838 27.603 14.846C27.89 15.853 28.006 16.949 28 17.982Z"
          fill={`url(#${body})`}
        />
        <ellipse cx="7.75" cy="14.5" rx="2" ry="1.1" transform="rotate(-50 7.75 14.5)" fill={`url(#${gloss})`} />
        <path
          d="M10 9C7 9 6 6.75 8 5C8.5 2.75 11.5 2 13 3C14.5 1.5 17.5 1.5 19 3C20.5 2 23.5 2.75 24 5C26 6.75 25 9 23 9Z"
          fill="#ffffff"
          stroke="#5b2358"
          strokeOpacity="0.7"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <path
          d="M12.5 8.75Q12 7 12.5 5.5M16 8.75V4.5M19.5 8.75Q20 7 19.5 5.5"
          stroke="#888491"
          strokeOpacity="0.45"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <rect
          x="9"
          y="9"
          width="14"
          height="3"
          rx="1"
          fill="#d2cfd8"
          stroke="#5b2358"
          strokeOpacity="0.7"
          strokeWidth="1"
        />
        <circle cx="10.5" cy="20.5" r="2.5" fill="#fbf9ff" />
        <circle cx="10.5" cy="20.5" r="1.5" fill="#5b2358" />
        <circle cx="10.08" cy="20.08" r="0.5" fill="#ffffff" />
        <circle cx="11.22" cy="21.22" r="0.5" fill="#ffffff" />
        <path d="M8.25 16Q11 13 13.75 16Q11 14.6 8.25 16Z" fill="#371435" fillOpacity="0.8" />
        <circle cx="20.5" cy="20.5" r="2.5" fill="#fbf9ff" />
        <circle cx="20.5" cy="20.5" r="1.5" fill="#5b2358" />
        <circle cx="20.08" cy="20.08" r="0.5" fill="#ffffff" />
        <circle cx="21.22" cy="21.22" r="0.5" fill="#ffffff" />
        <path d="M18.25 16Q21 13 23.75 16Q21 14.6 18.25 16Z" fill="#371435" fillOpacity="0.8" />
      </g>
      <g data-relay-chef-drawing="contrast">
        <path
          d="M28 17.982C27.994 19.015 27.822 20.057 27.569 21.045C27.317 22.032 26.945 22.991 26.485 23.906C26.025 24.821 25.478 25.718 24.81 26.535C24.142 27.351 23.367 28.159 22.477 28.805C21.586 29.451 20.545 30.046 19.465 30.412C18.386 30.777 17.155 31 16 31C14.845 31 13.614 30.777 12.535 30.412C11.455 30.046 10.414 29.451 9.523 28.805C8.633 28.159 7.858 27.351 7.19 26.535C6.522 25.718 5.975 24.821 5.515 23.906C5.055 22.991 4.683 22.032 4.431 21.045C4.178 20.057 4.006 19.015 4 17.982C3.994 16.949 4.11 15.853 4.397 14.846C4.684 13.838 5.147 12.81 5.723 11.938C6.298 11.065 7.06 10.255 7.849 9.609C8.639 8.962 9.562 8.451 10.459 8.057C11.355 7.662 12.305 7.418 13.229 7.242C14.152 7.066 15.076 7 16 7C16.924 7 17.848 7.066 18.771 7.242C19.695 7.418 20.645 7.662 21.541 8.057C22.438 8.451 23.361 8.962 24.151 9.609C24.94 10.255 25.702 11.065 26.277 11.938C26.853 12.81 27.316 13.838 27.603 14.846C27.89 15.853 28.006 16.949 28 17.982Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M10 9C7 9 6 6.75 8 5C8.5 2.75 11.5 2 13 3C14.5 1.5 17.5 1.5 19 3C20.5 2 23.5 2.75 24 5C26 6.75 25 9 23 9Z"
          fill="Canvas"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <rect x="9" y="9" width="14" height="3" rx="1" fill="Canvas" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="10.5" cy="20.5" r="2" stroke="currentColor" strokeWidth="1" />
        <circle cx="10.5" cy="20.5" r="1.5" fill="currentColor" />
        <path d="M8.25 16Q11 13 13.75 16Q11 14.6 8.25 16Z" fill="currentColor" fillOpacity="1" />
        <circle cx="20.5" cy="20.5" r="2" stroke="currentColor" strokeWidth="1" />
        <circle cx="20.5" cy="20.5" r="1.5" fill="currentColor" />
        <path d="M18.25 16Q21 13 23.75 16Q21 14.6 18.25 16Z" fill="currentColor" fillOpacity="1" />
      </g>
    </svg>
  )
}

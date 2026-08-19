/**
 * Theme color tokens for the TUI
 * @category theme
 */
export interface Theme {
  readonly background: string
  readonly backgroundPanel: string
  readonly backgroundElement: string
  readonly backgroundRaised: string
  readonly backgroundHeader: string
  readonly backgroundHeaderLoading: string
  readonly backgroundHeaderError: string
  readonly backgroundHeaderWarning: string

  readonly border: string
  readonly borderStrong: string
  readonly focus: string
  readonly accentTint: string
  readonly errorTint: string
  readonly warningTint: string
  readonly successTint: string

  readonly text: string
  readonly textMuted: string
  readonly textAccent: string
  readonly textError: string
  readonly textWarning: string
  readonly textSuccess: string

  readonly primary: string
  readonly error: string
  readonly warning: string
  readonly success: string

  readonly selectedBackground: string
  readonly selectedText: string

  readonly markdownText: string
  readonly markdownHeading: string
  readonly markdownLink: string
  readonly markdownLinkText: string
  readonly markdownCode: string
  readonly markdownCodeBlock: string
  readonly markdownBlockQuote: string
  readonly markdownListItem: string
  readonly markdownEmph: string
  readonly markdownStrong: string
  readonly markdownHorizontalRule: string
  readonly markdownImage: string
  readonly markdownImageText: string
}

/**
 * Terminal translation of the shared RLY / Control Center dark tokens.
 * Keep these values synchronized with packages/rly/src/styles/generated-tokens.css.
 */
export const controlCenterDarkTheme: Theme = {
  background: "#101114",
  backgroundPanel: "#17181c",
  backgroundElement: "#1e2025",
  backgroundRaised: "#282a31",
  backgroundHeader: "#101114",
  backgroundHeaderLoading: "#1e2025",
  backgroundHeaderError: "#3a1918",
  backgroundHeaderWarning: "#33270f",

  border: "#30323a",
  borderStrong: "#4c4f5a",
  focus: "#89b7ff",
  accentTint: "#302116",
  errorTint: "#3a1918",
  warningTint: "#33270f",
  successTint: "#153222",

  text: "#f4f4f6",
  textMuted: "#9396a0",
  textAccent: "#ff9b55",
  textError: "#ff8b82",
  textWarning: "#f0c66a",
  textSuccess: "#66d38b",

  primary: "#ff9b55",
  error: "#ff8b82",
  warning: "#f0c66a",
  success: "#66d38b",

  selectedBackground: "#282a31",
  selectedText: "#f4f4f6",

  markdownText: "#f4f4f6",
  markdownHeading: "#ff9b55",
  markdownLink: "#89b7ff",
  markdownLinkText: "#89b7ff",
  markdownCode: "#f0c66a",
  markdownCodeBlock: "#f4f4f6",
  markdownBlockQuote: "#9396a0",
  markdownListItem: "#f4f4f6",
  markdownEmph: "#f4f4f6",
  markdownStrong: "#f4f4f6",
  markdownHorizontalRule: "#30323a",
  markdownImage: "#89b7ff",
  markdownImageText: "#89b7ff"
}

/** Terminal translation of the shared RLY / Control Center light tokens. */
export const controlCenterLightTheme: Theme = {
  ...controlCenterDarkTheme,
  background: "#f6f6f8",
  backgroundPanel: "#ffffff",
  backgroundElement: "#f0f1f4",
  backgroundRaised: "#e8e9ed",
  backgroundHeader: "#f6f6f8",
  backgroundHeaderLoading: "#f0f1f4",
  backgroundHeaderError: "#fdecea",
  backgroundHeaderWarning: "#fff5dc",
  border: "#dadce2",
  borderStrong: "#b9bcc5",
  focus: "#006dff",
  accentTint: "#fff0e5",
  errorTint: "#fdecea",
  warningTint: "#fff5dc",
  successTint: "#eaf6ed",
  text: "#17181b",
  textMuted: "#6e717a",
  textAccent: "#c45500",
  textError: "#b42318",
  textWarning: "#7a5100",
  textSuccess: "#187a3a",
  primary: "#c45500",
  error: "#b42318",
  warning: "#7a5100",
  success: "#187a3a",
  selectedBackground: "#e8e9ed",
  selectedText: "#17181b",
  markdownText: "#17181b",
  markdownHeading: "#c45500",
  markdownLink: "#006dff",
  markdownLinkText: "#006dff",
  markdownCode: "#7a5100",
  markdownCodeBlock: "#17181b",
  markdownBlockQuote: "#6e717a",
  markdownListItem: "#17181b",
  markdownEmph: "#17181b",
  markdownStrong: "#17181b",
  markdownHorizontalRule: "#dadce2",
  markdownImage: "#006dff",
  markdownImageText: "#006dff"
}

export const defaultTheme: Theme = controlCenterDarkTheme

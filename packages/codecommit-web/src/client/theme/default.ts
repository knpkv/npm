/**
 * Theme color tokens for the web UI
 */
export interface Theme {
  readonly background: string
  readonly backgroundPanel: string
  readonly backgroundElement: string
  readonly backgroundHeader: string
  readonly backgroundHeaderLoading: string
  readonly backgroundHeaderError: string
  readonly backgroundHeaderWarning: string

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
}

export const defaultTheme: Theme = {
  background: "#171923",
  backgroundPanel: "#1A202C",
  backgroundElement: "#2D3748",
  backgroundHeader: "#1A365D",
  backgroundHeaderLoading: "#2C5282",
  backgroundHeaderError: "#880000",
  backgroundHeaderWarning: "#885500",

  text: "#FFFFFF",
  textMuted: "#A0AEC0",
  textAccent: "#63B3ED",
  textError: "#FC8181",
  textWarning: "#F6E05E",
  textSuccess: "#68D391",

  primary: "#1E3A5F",
  error: "#880000",
  warning: "#885500",
  success: "#276749",

  selectedBackground: "#2D3748",
  selectedText: "#FFFFFF"
}

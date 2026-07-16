/** Transport facts that affect browser security headers. */
export interface SecurityHeaderPolicy {
  readonly isSecureTransport: boolean
}

const BASE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self'"
]

/** Build the outer response headers applied to documents, APIs, errors, and static misses. */
export const securityHeaders = (policy: SecurityHeaderPolicy): Readonly<Record<string, string>> => {
  const directives = policy.isSecureTransport ? [...BASE_CSP, "upgrade-insecure-requests"] : BASE_CSP
  const headers: Record<string, string> = {
    "content-security-policy": directives.join("; "),
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": [
      "accelerometer=()",
      "bluetooth=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "serial=()",
      "usb=()"
    ].join(", "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  }
  if (policy.isSecureTransport) {
    headers["strict-transport-security"] = "max-age=31536000"
  }
  return headers
}

/** Whether a notification offers the interactive AWS SSO login action. */
export const isAwsAuthenticationNotification = (message: string): boolean =>
  /ExpiredToken|Unauthorized|AuthFailure|SSO|token|credentials|session may have expired/i.test(message)

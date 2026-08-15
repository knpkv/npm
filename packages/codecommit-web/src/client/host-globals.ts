/** Read the browser Notification constructor without evaluating a missing host global outside a guard. */
export const readNotificationApi = (): typeof Notification | undefined => {
  try {
    return Notification
  } catch {
    return undefined
  }
}

/** Read the browser Window object without evaluating a missing host global outside a guard. */
export const readBrowserWindow = (): Window | undefined => {
  try {
    return window
  } catch {
    return undefined
  }
}

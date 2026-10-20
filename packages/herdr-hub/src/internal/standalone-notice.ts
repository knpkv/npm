/**
 * The one stderr line hostd prints when it starts without a fleet configuration.
 *
 * @module
 */

/** Names the configuration path hostd looked for and the loopback URL it now serves. */
export const standaloneNotice = (configPath: string, url: string): string =>
  `hostd: no fleet config at ${configPath}; running standalone on ${
    url.endsWith("/") ? url : `${url}/`
  } (set FLEET_CONFIG_PATH to use one)`

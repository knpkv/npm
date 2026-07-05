/**
 * Confluence media alt text helpers.
 *
 * @internal
 */

// @atlaskit's media markdown plugin throws on escaped bracket alt text, and
// newlines split the image construct. Substitute those characters before a
// media preview reaches the Markdown parser.
export const sanitizeConfluenceMediaAlt = (value: string): string =>
  value.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\\/g, "/").replace(/\s+/g, " ").trim()

# Preserve Confluence media identity behind inline previews

Confluence image attachments should appear as ordinary Markdown image previews in page content, but push must reconstruct the original Confluence media nodes instead of turning them into generic external images. We will preserve the original media identity and attributes in hidden ADF metadata while exposing absolute attachment download URLs for human-readable local Markdown.

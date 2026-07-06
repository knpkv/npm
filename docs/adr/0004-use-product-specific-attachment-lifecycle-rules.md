# Use product-specific attachment lifecycle rules

Attachment Upload will follow the host product's attachment model instead of forcing one shared lifecycle across Jira and Confluence. Confluence uploads with an existing filename should create a new attachment version, while Jira uploads should add a new attachment even when the filename already exists, because Jira attachments are issue evidence and Confluence attachments are page assets.

# Separate provider accounts from followed resources

Control Center models an authorized external account or site separately from the resources followed beneath it, and keeps Plugin Connections as the executable bindings for those resources. This avoids duplicating account identity and credential selection for every AWS repository or pipeline while preserving resource-specific adapter configuration; the current one-connection-per-resource setup remains a transitional implementation until the new ownership seam is wired through persistence and APIs.

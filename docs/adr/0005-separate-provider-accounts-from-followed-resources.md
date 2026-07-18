# Separate provider accounts from followed resources

Control Center models an authorized external account or site separately from the resources followed beneath it, and keeps Plugin Connections as the executable bindings for those resources. This avoids duplicating account identity and credential selection for every AWS repository or pipeline while preserving resource-specific adapter configuration. A Plugin Connection is unbound only while setup is incomplete; once configured, it identifies exactly one Followed Resource, while many connections may share the same Provider Account.

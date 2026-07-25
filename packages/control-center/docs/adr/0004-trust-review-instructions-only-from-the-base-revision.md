# Trust review instructions only from the base revision

An Exploratory Review Run applies local review policy first and loads repository instructions only from the pull request's trusted base revision. Changes to `AGENTS.md`, provider instruction files, or prompt-like repository content in the reviewed head are treated as untrusted code under review and cannot direct the current agent. This prevents a pull request from weakening review policy, redirecting tool use, or manipulating its own assessment while still allowing instruction changes to be reviewed normally.

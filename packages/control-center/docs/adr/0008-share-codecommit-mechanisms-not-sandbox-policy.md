# Share CodeCommit mechanisms, not sandbox policy

CodeCommit authentication, profile discovery, exact repository checkout, and low-level Docker lifecycle mechanisms remain in `@knpkv/codecommit-core`. Its existing interactive code-server sandbox remains one policy, while Control Center's hardened agent Review Sandbox is a separate policy built from the same internal mechanisms. This preserves one CodeCommit integration and one Docker lifecycle implementation without forcing developer-sandbox host mounts, networking, ports, image defaults, or retention behavior into the review security model.

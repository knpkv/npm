# Share CodeCommit mechanisms, not sandbox policy

CodeCommit authentication, profile discovery, and exact repository checkout remain shared integration mechanisms. Control Center owns the separate agent Review Sandbox policy and implements it exclusively with the `sbx` CLI; it does not reuse the raw Docker lifecycle of an interactive developer sandbox. This preserves one CodeCommit integration without importing developer-sandbox host mounts, networking, ports, image defaults, or retention behavior into the review security model.

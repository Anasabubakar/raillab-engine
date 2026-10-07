# Security

RailLab is a local test tool. The server binds 127.0.0.1 only, limits request bodies to 64 KiB and holds no secrets. The external runner executes a command you give it; run only commands you trust.

Report vulnerabilities (for example a way to make the server reachable beyond loopback, to run code through scenario or event input, or to make an assertion pass when the consumer misbehaved) through GitHub's private vulnerability reporting for this repository. Please do not open a public issue for them.

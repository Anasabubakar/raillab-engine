# Overview

Make the anchor fail in the lab before the wallet fails for a user.

RailLab is a deterministic simulator of a SEP-24 **withdrawal** anchor for testing the **consumer** (a wallet or integration). It serves a documented subset of the SEP-24 API with a controllable virtual clock and a seeded fault scheduler, runs your client against delayed, repeated, reordered and failing responses, stale authentication and mismatched transaction ids, and checks what your client did against eight rules. Each rule is labelled **sep** (it follows from the SEP-24 text) or **policy** (a robustness choice no standard requires), so you can tell a bug from a preference.

The same scenario and seed always produce the identical timeline. The anchor, its bank, every identifier and every payment are **simulated**; nothing touches a real anchor, bank or the Stellar network.

Source: [raillab-engine on GitHub](https://github.com/Rail-L-b/raillab-engine). Releases: [GitHub releases](https://github.com/Rail-L-b/raillab-engine/releases).

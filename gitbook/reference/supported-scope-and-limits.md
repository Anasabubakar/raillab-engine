# Supported scope and limits

SEP-24 interactive withdrawal only (see [SPEC.md](https://github.com/Rail-L-b/raillab-engine/blob/main/SPEC.md)). `POST /auth` simulates the *outcome* of SEP-10 with an opaque token; it does not implement challenge signing. Not a conformance test for anchors. Faults model response behavior, not network-level conditions. Virtual time advances per request ([ADR 0002](https://github.com/Rail-L-b/raillab-engine/blob/main/docs/adr/0002-virtual-time-per-request.md)); a client is judged on request counts unless it reports its sleeps.

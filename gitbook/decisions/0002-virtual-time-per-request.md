# ADR 0002: Virtual time advances per request

Status: accepted, 2026-10-07.

Problem: consumers poll on their own timers. Tying faults to wall-clock time makes runs slow and flaky, and a timeline would depend on machine speed.

Decision: virtual time is discrete and advances by `requestIntervalMs` on every request, plus any sleep the consumer reports. Faults refer to poll numbers or virtual windows. A consumer that polls in a tight loop and one that sleeps for real see the same sequence; a consumer that wants to be judged on its backoff reports its sleep (`X-RailLab-Advance-Ms`, or `clock.sleep` in-process).

Consequences: runs are deterministic and fast; real network latency is not modeled, except an optional real-time hold (`latency.realMs`) for HTTP servers, which does not change the event order; a client that never reports sleeps is judged on request counts, not on its timers.

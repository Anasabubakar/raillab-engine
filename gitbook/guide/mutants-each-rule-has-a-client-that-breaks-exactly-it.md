# Mutants: each rule has a client that breaks exactly it

`MUTANTS` is the corrected client with one behavior removed (no re-authentication, no id check, no retry, no monotonic ordering, no idempotency, lax completion). The tests assert each fails the matching rule and no unrelated one, so the assertions are themselves tested against clients that are wrong in known ways.

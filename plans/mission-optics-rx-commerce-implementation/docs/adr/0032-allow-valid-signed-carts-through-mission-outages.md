# Allow Valid Signed Carts Through Mission Outages

An unchanged cart with an unexpired, locally verifiable Cart Authorization may complete checkout while Mission is unavailable. New or changed configurations remain unavailable, missing or invalid authorizations fail closed, and resulting orders stay quarantined until Mission recovers and revalidates every production predicate, preserving checkout availability without allowing manufacturing to fail open.

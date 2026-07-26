# Treat Webhooks as Notifications

Consequential commerce webhooks are verified, durably recorded, and deduplicated, but their payloads do not directly authorize state changes or manufacturing. Each event triggers retrieval of a current Commerce Snapshot, Mission applies an idempotent transition from that authoritative state, and scheduled reconciliation recovers missing or out-of-order deliveries.

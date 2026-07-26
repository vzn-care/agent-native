# Separate Subject-Owned Records From Merchant Cases

Prescription Subjects, Subject Claims, Prescription Records, Measurement Records, and subject authorizations live in a Mission-owned subject security domain rather than a merchant tenant. A merchant-scoped Prescription Case may reference exact record revisions only through an active, purpose-bound Subject Authorization for that pair. Merchant organization membership never grants access to those subject records. This permits subject-authorized reuse across merchants without duplicating protected data or weakening tenant isolation.

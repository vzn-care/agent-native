# Protect Rx Quote Prices Through Expiration

An Rx Quote guarantees its base component prices until its stated expiration, and merchant catalog changes affect only newly issued quotes. The commerce adapter must honor the locked prices while allowing approved platform discounts, tax, and shipping to be calculated separately; an expired quote requires re-quoting, and a platform that cannot safely honor an unexpired quote blocks checkout rather than charging a different base amount.

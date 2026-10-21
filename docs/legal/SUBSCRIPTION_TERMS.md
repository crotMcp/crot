# CROT subscription terms — publication template

These terms supplement the Terms of Service. **Merchant of record, legal entity, prices, currency, tax treatment, billing interval, refund law and effective date must be inserted and legally reviewed before checkout is enabled.**

## Plans

| Plan | Repository entitlement contract |
| --- | --- |
| Free | local/offline features; remote relay disabled; 0 remote devices |
| Trial | 14 days, one trial per account, up to 2 remote devices |
| Pro | remote access for up to 5 devices |
| Team | remote access for up to 20 devices |

Published checkout may add price and billing interval but must not silently change these technical limits without a reviewed release/terms update. Device limits count non-revoked registered devices. A downgrade immediately denies excess devices deterministically; local mode is unaffected.

## Purchase, renewal and taxes

The checkout must disclose `[PRICE/CURRENCY/INTERVAL]`, merchant `[ENTITY]`, taxes, renewal date and any trial conversion before confirmation. Unless canceled, a recurring plan renews automatically as disclosed. The user authorizes Stripe/the merchant to charge the payment method. Failed/past-due/canceled/expired subscriptions lose remote admission; CROT does not disable local mode.

## Trial

A trial starts only when the account holder requests it. It lasts 14 days, allows two devices and cannot be repeated for the same account. State whether payment details are required and whether it converts automatically: `[OPERATOR CHOICE AND REQUIRED NOTICE]`.

## Cancellation, refunds and changes

Users cancel through `[PORTAL/CONTACT]`. State the effective time and access treatment: `[END OF PERIOD/IMMEDIATE]`. Refunds and withdrawal rights are `[POLICY AND MANDATORY LAW]`. Price/plan changes require advance notice of `[PERIOD]` and do not retroactively alter accrued charges.

## Billing records and disputes

Invoices/receipts are provided by `[MERCHANT/STRIPE]`. Billing disputes go to `[CONTACT]` within `[PERIOD]`, without limiting mandatory rights. Chargebacks/fraud may suspend cloud access while investigated. Subscription identifiers and status are processed as described in the privacy policy; complete card data is not stored by CROT.

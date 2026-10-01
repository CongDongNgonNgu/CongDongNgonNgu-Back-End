BEGIN;

DROP INDEX IF EXISTS membership_credit_redemptions_user_time_idx;
DROP TABLE IF EXISTS membership_credit_redemptions;

DROP INDEX IF EXISTS membership_subscription_events_user_time_idx;
DROP TABLE IF EXISTS membership_subscription_events;

DROP INDEX IF EXISTS membership_payment_fulfillments_user_status_idx;
DROP TABLE IF EXISTS membership_payment_fulfillments;

DROP INDEX IF EXISTS membership_payment_settlements_order_idx;
DROP TABLE IF EXISTS membership_payment_settlements;

DROP INDEX IF EXISTS membership_payment_webhook_events_reference_idx;
DROP TABLE IF EXISTS membership_payment_webhook_events;

COMMIT;

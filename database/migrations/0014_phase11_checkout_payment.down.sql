BEGIN;

DROP INDEX IF EXISTS membership_payment_attempts_user_status_idx;
DROP INDEX IF EXISTS membership_payment_attempts_order_history_idx;
DROP INDEX IF EXISTS membership_payment_attempts_one_open_per_order;
DROP TABLE IF EXISTS membership_payment_attempts;

DROP INDEX IF EXISTS membership_checkout_orders_user_status_idx;
DROP TABLE IF EXISTS membership_checkout_orders;

DROP INDEX IF EXISTS membership_plan_prices_purchase_idx;
DROP TABLE IF EXISTS membership_plan_prices;

DROP TYPE IF EXISTS membership_payment_attempt_status;
DROP TYPE IF EXISTS membership_order_status;
DROP TYPE IF EXISTS membership_payment_currency;
DROP TYPE IF EXISTS membership_price_period_unit;
DROP TYPE IF EXISTS membership_price_status;

COMMIT;

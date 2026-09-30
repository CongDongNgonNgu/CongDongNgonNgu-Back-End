BEGIN;

DROP INDEX IF EXISTS membership_subscriptions_user_period_idx;
DROP INDEX IF EXISTS membership_entitlement_feature_idx;
DROP INDEX IF EXISTS membership_plan_versions_status_idx;
DROP INDEX IF EXISTS membership_subscriptions_active_user_unique;

DROP TABLE IF EXISTS membership_subscriptions;
DROP TABLE IF EXISTS membership_entitlement_definitions;
DROP TABLE IF EXISTS membership_plan_versions;
DROP TABLE IF EXISTS membership_products;

DROP TYPE IF EXISTS membership_subscription_source;
DROP TYPE IF EXISTS membership_subscription_status;
DROP TYPE IF EXISTS membership_plan_version_status;
DROP TYPE IF EXISTS membership_product_status;

COMMIT;

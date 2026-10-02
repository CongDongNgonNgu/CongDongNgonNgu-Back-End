BEGIN;

-- PostgreSQL enum values are additive here. Existing MEMBER/MODERATOR/ADMIN
-- rows remain valid; the policy layer deliberately keeps MEMBER as a legacy
-- compatibility role until a later, explicitly planned data migration.
ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'USER';
ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'CONTRIBUTOR';
ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'EXPERT';

COMMIT;

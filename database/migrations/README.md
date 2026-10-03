# Backend migrations and seeds

The identity and language-profile schemas are reproducible from a clean
Postgres database:

~~~powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/0001_identity.sql
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/0002_language_profile.sql
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/seeds/0002_language_catalog.sql
~~~

The language seed is idempotent and may be rerun after the schema migration.
Run these commands only against an explicitly selected development or test
database. The down migrations are recovery/development aids, not production
rollback plans: take a verified backup and use an approved migration process
before removing identity or profile data.

The application defaults to Postgres outside NODE_ENV=test. Test-only memory
persistence is available with AUTH_PERSISTENCE=memory; production startup
rejects that setting.

## Phase 18 UAT fixtures

After the migrations and language catalog are applied to a selected TEST or
non-production UAT database, use the guarded backend command from the backend
repository:

~~~powershell
npm run build
npm run uat:seed -- --environment TEST --dry-run
~~~

The non-dry command requires `DATABASE_URL`,
`UAT_SEED_EXPECTED_DATABASE_HOST`, `UAT_SEED_EXPECTED_DATABASE_NAME`,
`UAT_SEED_ALLOWED_DATABASE_HOSTS`, the exact confirmation token
`CONGDONGNGONNGU_PHASE18_UAT_ONLY`, and a 12-to-128-character
`UAT_SEED_PASSWORD`. The password is runtime-only and must not be stored in
the repository. The runner permits only TEST/UAT, uses transaction-scoped
upserts for dedicated `example.invalid` personas, and has no reset or delete
mode. Never point it at production or use it as a production migration or
rollback mechanism.

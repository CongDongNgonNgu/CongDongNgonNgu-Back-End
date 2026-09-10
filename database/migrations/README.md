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

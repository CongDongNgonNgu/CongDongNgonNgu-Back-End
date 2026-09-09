# Identity migration

The Phase 02 identity schema is reproducible from a clean Postgres database:

~~~powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/0001_identity.sql
~~~

Run it only against an explicitly selected development or test database. The
down migration is a recovery/development aid, not a production rollback plan:
take a verified backup and use an approved migration process before removing
identity data.

The application defaults to Postgres outside NODE_ENV=test. Test-only memory
persistence is available with AUTH_PERSISTENCE=memory; production startup
rejects that setting.

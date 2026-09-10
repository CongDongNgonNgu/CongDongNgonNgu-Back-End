const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const LOCK_ID = 20260910;

function checksum(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
  });

  const client = await pool.connect();

  try {
    console.log("Connecting to database...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    console.log("Acquiring migration lock...");

    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
      .sort();

    console.log(`Found ${files.length} migration(s).`);

    for (const filename of files) {
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(filePath, "utf8");
      const currentChecksum = checksum(sql);

      const existing = await client.query(
        `
        SELECT filename, checksum
        FROM schema_migrations
        WHERE filename = $1
        `,
        [filename],
      );

      if (existing.rowCount > 0) {
        const recordedChecksum = existing.rows[0].checksum;

        if (recordedChecksum !== currentChecksum) {
          throw new Error(
            `MIGRATION_CHECKSUM_MISMATCH: ${filename} was already applied but has been modified.`,
          );
        }

        console.log(`SKIP ${filename}`);
        continue;
      }

      console.log(`APPLY ${filename}`);

      await client.query("BEGIN");

      try {
        await client.query(sql);

        await client.query(
          `
          INSERT INTO schema_migrations (
            filename,
            checksum
          )
          VALUES ($1, $2)
          `,
          [filename, currentChecksum],
        );

        await client.query("COMMIT");

        console.log(`DONE ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("Database migrations are up to date.");
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    } catch {
      // Ignore unlock errors during shutdown.
    }

    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:");
  console.error(error);
  process.exit(1);
});

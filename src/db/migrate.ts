import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import dotenv from 'dotenv';
dotenv.config();

console.log('Starting migration...');
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false, // Needed for RDS or any managed Postgres requiring SSL
  },
});

console.log('Connected to database:', process.env.DB_NAME);
const db = drizzle(pool);

async function main() {
  await migrate(db, { migrationsFolder: 'main' });
}

main().catch((e) => {
  console.error(e);
  process.exit(0);
});

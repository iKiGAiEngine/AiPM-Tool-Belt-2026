import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Managed Postgres (Replit/Neon) drops idle connections. When that happens the pool
// emits an 'error' event on the dead client; without a listener Node treats it as an
// unhandled 'error' and crashes the whole process. Log it instead so the app keeps
// running and the pool transparently re-establishes connections on the next query.
pool.on("error", (err) => {
  console.error("[db] Unexpected Postgres pool error (idle client):", err.message);
});

export const db = drizzle(pool, { schema });

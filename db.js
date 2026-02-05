require("dotenv").config();
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL in environment");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function healthcheck() {
  const result = await query("select now() as now");
  return result.rows[0];
}

module.exports = { query, pool, healthcheck };


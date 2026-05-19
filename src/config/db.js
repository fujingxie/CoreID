const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({
  connectionString,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL error:", error);
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = {
  pool,
  query,
};

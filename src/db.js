import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // requerido por Neon en Render
});

export async function query(text, params) {
  return pool.query(text, params);
}
export async function getClient() {
  return pool.connect();
}


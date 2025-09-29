// db.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import bcrypt from "bcryptjs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DB_ENGINE = (process.env.DB_ENGINE || "sqlite").toLowerCase();
const DB_PATH = process.env.DATA_PATH || path.join(__dirname, "data.db");

let db;          // API compatible con .prepare().get/.all/.run y .exec()
let pool = null; // Postgres pool

// Reemplaza '?' por '$1,$2,...' para Postgres
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Ejecuta varias sentencias separadas por ';' en Postgres
async function execManyPg(sql) {
  const parts = sql.split(";").map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    await pool.query(p);
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS empresas (
  id TEXT PRIMARY KEY,
  razon_social TEXT NOT NULL,
  ruc TEXT,
  direccion TEXT,
  telefono TEXT,
  logo_base64 TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nombres TEXT NOT NULL,
  apellidos TEXT NOT NULL,
  dni TEXT,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  empresa_id TEXT REFERENCES empresas(id),
  proyecto_principal TEXT,
  password_hash TEXT NOT NULL,
  correlativo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS planillas (
  id TEXT PRIMARY KEY,
  serie TEXT NOT NULL,
  numero TEXT NOT NULL,
  usuario_id TEXT REFERENCES usuarios(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  total NUMERIC NOT NULL DEFAULT 0,
  proyecto TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS planilla_detalles (
  id TEXT PRIMARY KEY,
  planilla_id TEXT REFERENCES planillas(id) ON DELETE CASCADE,
  destino TEXT,
  motivo TEXT,
  proyecto TEXT,
  pc TEXT,
  monto NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_planillas_usuario_fecha ON planillas(usuario_id, fecha);
`;

async function seedIfEmpty() {
  const row = await db.prepare("SELECT id FROM usuarios LIMIT 1").get();
  if (row) return;

  await db.exec(`
    INSERT INTO empresas (id, razon_social, ruc, direccion, telefono, logo_base64) VALUES
    ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331',NULL),
    ('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331',NULL)
  `);

  const passAdmin = bcrypt.hashSync("admin123", 8);
  const passUser  = bcrypt.hashSync("usuario123", 8);

  await db.prepare(
    "INSERT INTO usuarios (id,nombres,apellidos,dni,email,role,empresa_id,proyecto_principal,password_hash,correlativo) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run("admin","YRVING","LEON","44895702","admin@empresa.com","ADMIN_PADOVA","INV_PADOVA","ADMIN PADOVA",passAdmin,0);

  await db.prepare(
    "INSERT INTO usuarios (id,nombres,apellidos,dni,email,role,empresa_id,proyecto_principal,password_hash,correlativo) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run("user1","JOEL","GARGATE","44081950","usuario@empresa.com","OBRA","CONS_PADOVA","SANTA BEATRIZ",passUser,0);
}

export async function initDb() {
  if (DB_ENGINE === "postgres") {
    const { Pool } = pg;
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    // Adaptador con API estilo better-sqlite3
    db = {
      exec: execManyPg,
      prepare(sql) {
        return {
          async get(...params) {
            const text = toPgPlaceholders(sql) + " LIMIT 1";
            const r = await pool.query(text, params);
            return r.rows[0] || null;
          },
          async all(...params) {
            const r = await pool.query(toPgPlaceholders(sql), params);
            return r.rows;
          },
          async run(...params) {
            const r = await pool.query(toPgPlaceholders(sql), params);
            return { changes: r.rowCount };
          },
        };
      },
    };

    await db.exec(SCHEMA_SQL);
    await seedIfEmpty();
    return;
  }

  // -------- SQLite local (solo se importa better-sqlite3 si se necesita) --------
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(DB_PATH);

  // En SQLite podemos usar el objeto nativo directamente; 'await' sobre valores no-promesa es seguro.
  sqlite.exec(SCHEMA_SQL.replaceAll("TIMESTAMP", "TEXT").replaceAll("NOW()", "CURRENT_TIMESTAMP"));
  db = sqlite;

  await seedIfEmpty();
}

export { db };

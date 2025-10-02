// server.mjs
import express from "express";
import cors from "cors";
import pkg from "pg";                 // pg es CommonJS; usa default import
const { Pool } = pkg;

import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const {
  DATABASE_URL,
  CORS_ORIGIN = "*",
  PORT = 10000,               // Render asigna PORT; respetamos si lo define
  ADMIN_PIN = "1234",
  TOPE = "45",
  NODE_ENV = "production",
} = process.env;

if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL en variables de entorno.");
  process.exit(1);
}

// Pool a Neon (con SSL)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(cors({ origin: CORS_ORIGIN }));

// ---------- Helper de consultas
async function q(text, params = []) {
  const c = await pool.connect();
  try { return await c.query(text, params); }
  finally { c.release(); }
}

// ---------- Bootstrap mínimo (tablas + vista login)
async function bootstrap() {
  await q(`
    CREATE TABLE IF NOT EXISTS empresas(
      id        TEXT PRIMARY KEY,
      razon     TEXT NOT NULL,
      ruc       TEXT NOT NULL,
      direccion TEXT DEFAULT '',
      telefono  TEXT DEFAULT '',
      logo      TEXT DEFAULT ''
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS usuarios(
      email     TEXT PRIMARY KEY,
      dni       TEXT NOT NULL,
      nombres   TEXT NOT NULL,
      apellidos TEXT NOT NULL,
      rol       TEXT NOT NULL,
      activo    TEXT DEFAULT '1',
      empresaid TEXT NOT NULL REFERENCES empresas(id),
      proydef   TEXT DEFAULT '',
      proys     TEXT[] DEFAULT '{}'::TEXT[]
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS pcs(
      codigo    TEXT NOT NULL,
      empresaid TEXT NOT NULL REFERENCES empresas(id),
      PRIMARY KEY(codigo, empresaid)
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS planillas(
      id          BIGSERIAL PRIMARY KEY,
      email       TEXT NOT NULL,
      dni         TEXT NOT NULL,
      fecha       DATE NOT NULL,
      empresaid   TEXT NOT NULL,
      proyecto    TEXT DEFAULT '',
      items       JSONB NOT NULL,
      total       NUMERIC(12,2) NOT NULL DEFAULT 0,
      serie       TEXT NOT NULL,
      num         INTEGER NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(email, num)
    );
  `);

  // Vista de login robusta (CAST antes de COALESCE)
  await q(`
    CREATE OR REPLACE VIEW v_usuarios_login AS
    SELECT
      email,
      dni,
      nombres,
      apellidos,
      rol,
      CASE
        WHEN COALESCE((activo)::TEXT,'') IN ('1','t','true','TRUE')
        THEN TRUE ELSE FALSE
      END AS activo,
      empresaid,
      proydef,
      COALESCE(proys,'{}'::TEXT[]) AS proys
    FROM usuarios;
  `);
}

// ---------- Utilidades
function serieFromNombre(nombres = "", apellidos = "") {
  const n = String(nombres).trim().toUpperCase();
  const a = String(apellidos).trim().toUpperCase();
  const s1 = n ? n[0] : "X";
  const s2 = a ? a[0] : "X";
  return `${s1}${s2}`; // p.ej. YL
}

async function nextCorrelativo(email) {
  const r = await q(`SELECT COALESCE(MAX(num),0)+1 AS n FROM planillas WHERE email=$1`, [email]);
  return Number(r.rows?.[0]?.n || 1);
}

// ---------- API
app.get("/api/health", (_req, res) => res.json({ ok:true, env: NODE_ENV }));

app.get("/api/login", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Falta email" });
    const r = await q(`SELECT * FROM v_usuarios_login WHERE lower(email)=lower($1)`, [email]);
    const u = r.rows?.[0];
    if (!u)   return res.status(404).json({ error: "Usuario no encontrado" });
    if (!u.activo) return res.status(403).json({ error: "Usuario inactivo" });
    res.json(u);
  } catch (e) {
    console.error("login error:", e);
    res.status(500).json({ error: "Error en login" });
  }
});

app.get("/api/empresas", async (req, res) => {
  try {
    const simple = String(req.query.simple || "0") === "1";
    const r = await q(`SELECT * FROM empresas ORDER BY id`);
    if (simple) return res.json(r.rows.map(({id,razon,ruc}) => ({id,razon,ruc})));
    res.json(r.rows);
  } catch (e) {
    console.error("empresas error:", e);
    res.status(500).json({ error: "Error listando empresas" });
  }
});

app.get("/api/usuarios", async (_req, res) => {
  try {
    const r = await q(`
      SELECT email,dni,nombres,apellidos,rol,empresaid,proydef,proys,
             CASE WHEN COALESCE((activo)::TEXT,'') IN ('1','t','true','TRUE')
                  THEN TRUE ELSE FALSE END AS activo
      FROM usuarios
      ORDER BY apellidos, nombres
    `);
    res.json(r.rows);
  } catch (e) {
    console.error("usuarios error:", e);
    res.status(500).json({ error: "Error listando usuarios" });
  }
});

app.get("/api/pcs", async (req, res) => {
  try {
    const empresaid = String(req.query.empresaid || "");
    const r = await q(`SELECT codigo FROM pcs WHERE empresaid=$1 ORDER BY codigo`, [empresaid]);
    res.json(r.rows.map(x => x.codigo));
  } catch (e) {
    console.error("pcs error:", e);
    res.status(500).json({ error: "Error listando PCs" });
  }
});

app.post("/api/planillas", async (req, res) => {
  try {
    const { email, dni, fecha, items = [], empresaid, proyecto = "" } = req.body || {};
    if (!email || !dni || !fecha || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const total = items.reduce((a,it)=> a + Number(it.monto || 0), 0);
    const tope  = Number(TOPE || 45);
    if (total > tope) {
      return res.status(400).json({ error: `Supera el tope diario de S/ ${tope.toFixed(2)}` });
    }

    const ru = await q(`SELECT nombres,apellidos,empresaid FROM usuarios WHERE lower(email)=lower($1)`, [email]);
    const u  = ru.rows?.[0];
    if (!u) return res.status(404).json({ error: "Usuario no existe" });

    const serie = serieFromNombre(u.nombres, u.apellidos);
    const num   = await nextCorrelativo(email);

    await q(`
      INSERT INTO planillas(email,dni,fecha,empresaid,proyecto,items,total,serie,num)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [email, dni, fecha, empresaid || u.empresaid, proyecto, JSON.stringify(items), total, serie, num]);

    res.json({
      ok: true,
      serie,
      num: String(num).padStart(5, "0"),
      total: Number(total).toFixed(2),
      fecha,
      empresa: { id: empresaid || u.empresaid },
    });
  } catch (e) {
    console.error("guardar planilla error:", e);
    res.status(500).json({ error: "No se pudo guardar la planilla" });
  }
});

app.get("/api/historial", async (req, res) => {
  try {
    const email = String(req.query.email || "").toLowerCase();
    if (!email) return res.status(400).json({ error: "Falta email" });
    const r = await q(`
      SELECT id,fecha,empresaid,proyecto,total,serie,num,items,created_at
      FROM planillas
      WHERE lower(email)=lower($1)
      ORDER BY created_at DESC
    `, [email]);
    res.json(r.rows);
  } catch (e) {
    console.error("historial error:", e);
    res.status(500).json({ error: "Error listando historial" });
  }
});

app.post("/api/admin/pin", (req, res) => {
  const { pin } = req.body || {};
  if (String(pin) === String(ADMIN_PIN)) return res.json({ ok: true });
  return res.status(401).json({ error: "PIN inválido" });
});

// Servir estáticos desde /public
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Fallback SPA: cualquier ruta que no empiece con /api
app.get(/^\/(?!api).*/, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);


// ---------- Arranque
const server = app.listen(PORT, async () => {
  try {
    await bootstrap();
    console.log(`API lista en puerto ${PORT}`);
  } catch (e) {
    console.error("Bootstrap error", e);
    process.exit(1);
  }
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));

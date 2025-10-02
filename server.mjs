import express from "express";
import cors from "cors";
import pkg from "pg";                 // <- default import para CommonJS
const { Pool } = pkg;

const {
  DATABASE_URL,
  CORS_ORIGIN = "*",
  PORT = 10000,
  ADMIN_PIN = "1234",
  TOPE = "45",                       // tope por día (texto -> number luego)
  NODE_ENV = "production",
} = process.env;

if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL en variables de entorno.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Si tu Neon requiere SSL:
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(cors({ origin: CORS_ORIGIN }));

// Helper DB
async function q(text, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

/* ----------------------- Bootstrap mínimo seguro ----------------------- */
async function bootstrap() {
  // Asegura tablas básicas (ajústalo si ya están creadas).
  await q(`
    CREATE TABLE IF NOT EXISTS empresas(
      id        TEXT PRIMARY KEY,
      razon     TEXT NOT NULL,
      ruc       TEXT NOT NULL,
      direccion TEXT DEFAULT '',
      telefono  TEXT DEFAULT '',
      logo      TEXT DEFAULT '' -- base64 opcional
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS usuarios(
      email     TEXT PRIMARY KEY,
      dni       TEXT NOT NULL,
      nombres   TEXT NOT NULL,
      apellidos TEXT NOT NULL,
      rol       TEXT NOT NULL,      -- ADMIN_PADOVA | USUARIO
      activo    TEXT DEFAULT '1',   -- puede venir 1/0, true/false, etc.
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

  // Vista de login robusta (¡usa CAST antes de COALESCE!)
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

/* -------------------------- Utilidades varias -------------------------- */
function serieFromNombre(nombres = "", apellidos = "") {
  const n = String(nombres).trim().toUpperCase();
  const a = String(apellidos).trim().toUpperCase();
  const s1 = n ? n[0] : "X";
  const s2 = a ? a[0] : "X";
  return `${s1}${s2}`; // p.ej. YL
}

async function nextCorrelativo(email) {
  const r = await q(`SELECT COALESCE(MAX(num),0)+1 AS n FROM planillas WHERE email=$1`, [email]);
  const n = r.rows?.[0]?.n || 1;
  return Number(n);
}

/* --------------------------------- API --------------------------------- */

// Ping
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, env: NODE_ENV });
});

// Login por email
app.get("/api/login", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Falta email" });

    const r = await q(`SELECT * FROM v_usuarios_login WHERE lower(email)=lower($1)`, [email]);
    const u = r.rows?.[0];
    if (!u) return res.status(404).json({ error: "Usuario no encontrado" });
    if (!u.activo) return res.status(403).json({ error: "Usuario inactivo" });
    res.json(u);
  } catch (e) {
    console.error("login error:", e);
    res.status(500).json({ error: "Error en login" });
  }
});

// Empresas
app.get("/api/empresas", async (req, res) => {
  try {
    const simple = String(req.query.simple || "0") === "1";
    const r = await q(`SELECT * FROM empresas ORDER BY id`);
    if (simple) {
      const out = r.rows.map(({ id, razon, ruc }) => ({ id, razon, ruc }));
      return res.json(out);
    }
    res.json(r.rows);
  } catch (e) {
    console.error("empresas error:", e);
    res.status(500).json({ error: "Error listando empresas" });
  }
});

// Usuarios (lista para selects)
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

// PCs por empresa (para combos)
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

// Guardar planilla
app.post("/api/planillas", async (req, res) => {
  try {
    const { email, dni, fecha, items = [], empresaid, proyecto = "" } = req.body || {};
    if (!email || !dni || !fecha || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    // Total
    const total = items.reduce((acc, it) => acc + Number(it.monto || 0), 0);
    const tope = Number(TOPE || 45);
    if (total > tope) {
      return res.status(400).json({ error: `Supera el tope diario de S/ ${tope.toFixed(2)}` });
    }

    // Datos del usuario (serie)
    const ru = await q(`SELECT nombres,apellidos,empresaid FROM usuarios WHERE lower(email)=lower($1)`, [email]);
    const u = ru.rows?.[0];
    if (!u) return res.status(404).json({ error: "Usuario no existe" });

    const serie = serieFromNombre(u.nombres, u.apellidos);
    const num = await nextCorrelativo(email);

    await q(`
      INSERT INTO planillas(email,dni,fecha,empresaid,proyecto,items,total,serie,num)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [email, dni, fecha, empresaid || u.empresaid, proyecto || "", JSON.stringify(items), total, serie, num]);

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

// Historial propio
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

// Validar PIN admin
app.post("/api/admin/pin", (req, res) => {
  const { pin } = req.body || {};
  if (String(pin) === String(ADMIN_PIN)) return res.json({ ok: true });
  return res.status(401).json({ error: "PIN inválido" });
});

/* ---------------------------- Arranque server --------------------------- */
const server = app.listen(PORT, async () => {
  try {
    await bootstrap();
    console.log(`API lista en puerto ${PORT}`);
  } catch (e) {
    console.error("Bootstrap error", e);
    process.exit(1);
  }
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

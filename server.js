// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "cambia-esto-en-produccion";

// ---------- DB (Neon / Postgres) ----------
if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL en variables de entorno.");
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon requiere SSL
  ssl: { rejectUnauthorized: false },
});

// ---------- Helpers ----------
const serieFromName = (n = "", a = "") =>
  (n.slice(0, 2) + (a || "").slice(0, 2)).toUpperCase() + "001";

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

function onlyAdmin(req, res, next) {
  if (req.user?.rol === "ADMIN_PADOVA") return next();
  return res.status(403).json({ error: "Solo administradores" });
}

// ---------- Bootstrapping básico ----------
async function ensureSchema() {
  const q = `
  CREATE TABLE IF NOT EXISTS empresas(
    id TEXT PRIMARY KEY,
    razon TEXT NOT NULL,
    ruc TEXT NOT NULL,
    direccion TEXT,
    telefono TEXT,
    logo TEXT
  );

  CREATE TABLE IF NOT EXISTS usuarios(
    id SERIAL PRIMARY KEY,
    activo INTEGER NOT NULL DEFAULT 1,
    dni TEXT UNIQUE NOT NULL,
    nombres TEXT NOT NULL,
    apellidos TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    empresaId TEXT NOT NULL REFERENCES empresas(id),
    rol TEXT NOT NULL,
    proyDef TEXT,
    proyectos TEXT,
    password_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS counters(
    dni TEXT PRIMARY KEY,
    n INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS historial(
    id SERIAL PRIMARY KEY,
    serie TEXT NOT NULL,
    num TEXT NOT NULL,
    fecha TEXT NOT NULL,
    dni TEXT NOT NULL,
    email TEXT,
    trabajador TEXT,
    proyecto TEXT,
    destino TEXT,
    motivo TEXT,
    pc TEXT,
    monto REAL NOT NULL,
    total REAL NOT NULL
  );
  `;
  await pool.query(q);

  // semillas si está vacío
  const { rows: re } = await pool.query("SELECT COUNT(*)::int c FROM empresas");
  if (re[0].c === 0) {
    const dir = "JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA";
    const tel = "495-1331";
    await pool.query(
      `INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo) VALUES
       ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598',$1,$2,''),
       ('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341',$1,$2,'')`,
      [dir, tel]
    );
  }

  const { rows: ru } = await pool.query("SELECT COUNT(*)::int c FROM usuarios");
  if (ru[0].c === 0) {
    const pAdmin = bcrypt.hashSync("admin123", 8);
    const pUser = bcrypt.hashSync("usuario123", 8);
    await pool.query(
      `INSERT INTO usuarios(activo,dni,nombres,apellidos,email,empresaId,rol,proyDef,proyectos,password_hash)
       VALUES
       (1,'44895702','YRVING','LEON','admin@empresa.com','INV_PADOVA','ADMIN_PADOVA','ADMIN PADOVA','ADMIN PADOVA,LITORAL 900,SANTA BEATRIZ',$1),
       (1,'44081950','JOEL','GARGATE','usuario@empresa.com','CONS_PADOVA','USUARIO','SANTA BEATRIZ','SANTA BEATRIZ',$2)`,
      [pAdmin, pUser]
    );
  }
}
await ensureSchema();

// ---------- Auth ----------
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email requerido" });
    const { rows } = await pool.query(
      "SELECT * FROM usuarios WHERE LOWER(email)=LOWER($1) LIMIT 1",
      [String(email)]
    );
    const u = rows[0];
    if (!u || u.activo !== 1)
      return res.status(401).json({ error: "Usuario no existe o inactivo" });

    if (u.password_hash) {
      const ok = bcrypt.compareSync(password || "", u.password_hash);
      if (!ok) return res.status(401).json({ error: "Clave incorrecta" });
    }

    const token = jwt.sign(
      { uid: u.id, email: u.email, dni: u.dni, rol: u.rol },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    // datos para cabecera
    const { rows: ce } = await pool.query(
      `SELECT e.id, e.razon, e.ruc, e.direccion, e.telefono, e.logo
       FROM empresas e WHERE e.id=$1`,
      [u.empresaid]
    );
    const e = ce[0] || {};
    const serieBase = serieFromName(u.nombres, u.apellidos);

    res.json({
      token,
      me: {
        id: u.id,
        dni: u.dni,
        nombres: u.nombres,
        apellidos: u.apellidos,
        email: u.email,
        rol: u.rol,
        proyDef: u.proydef || "",
        empresaId: u.empresaid,
        empresa: e,
        serieBase,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login fallo" });
  }
});

// Detalle del usuario logueado + empresa
app.get("/api/me", auth, async (req, res) => {
  const { uid } = req.user;
  const { rows } = await pool.query("SELECT * FROM usuarios WHERE id=$1", [uid]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: "No encontrado" });
  const { rows: ce } = await pool.query(
    `SELECT e.id, e.razon, e.ruc, e.direccion, e.telefono, e.logo
     FROM empresas e WHERE e.id=$1`,
    [u.empresaid]
  );
  const e = ce[0] || {};
  const serieBase = serieFromName(u.nombres, u.apellidos);
  res.json({
    id: u.id,
    dni: u.dni,
    nombres: u.nombres,
    apellidos: u.apellidos,
    email: u.email,
    rol: u.rol,
    proyDef: u.proydef || "",
    empresaId: u.empresaid,
    empresa: e,
    serieBase,
  });
});

// ---------- Empresas ----------
app.get("/api/empresas", auth, async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, razon, ruc, direccion, telefono, logo FROM empresas ORDER BY id"
  );
  res.json(rows);
});

app.put("/api/empresas", auth, onlyAdmin, async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const up = `
      INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET
        razon=EXCLUDED.razon,
        ruc=EXCLUDED.ruc,
        direccion=EXCLUDED.direccion,
        telefono=EXCLUDED.telefono,
        logo=EXCLUDED.logo
    `;
    for (const e of list) {
      await client.query(up, [
        e.id, e.razon, e.ruc, e.direccion || "", e.telefono || "", e.logo || "",
      ]);
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Error guardando empresas" });
  } finally {
    client.release();
  }
});

// ---------- Usuarios ----------
app.get("/api/usuarios", auth, async (req, res) => {
  if (req.user.rol === "ADMIN_PADOVA") {
    const { rows } = await pool.query(
      "SELECT * FROM usuarios ORDER BY apellidos, nombres"
    );
    return res.json(rows);
  }
  const { rows } = await pool.query("SELECT * FROM usuarios WHERE id=$1", [
    req.user.uid,
  ]);
  res.json(rows);
});

// Guarda/actualiza usuarios (incluye dni, empresaId y proyDef)
app.put("/api/usuarios", auth, onlyAdmin, async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = `
      INSERT INTO usuarios(activo,dni,nombres,apellidos,email,empresaId,rol,proyDef,proyectos)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id
    `;
    const upd = `
      UPDATE usuarios SET
        activo=$1, dni=$2, nombres=$3, apellidos=$4, email=$5,
        empresaId=$6, rol=$7, proyDef=$8, proyectos=$9
      WHERE id=$10
    `;

    for (const u of list) {
      const activo = u.activo ? 1 : 0;
      if (u.id) {
        await client.query(upd, [
          activo, u.dni, u.nombres, u.apellidos, u.email,
          u.empresaId, u.rol, u.proyDef || "", u.proyectos || "", u.id,
        ]);
      } else {
        await client.query(ins, [
          activo, u.dni, u.nombres, u.apellidos, u.email,
          u.empresaId, u.rol, u.proyDef || "", u.proyectos || "",
        ]);
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Error guardando usuarios" });
  } finally {
    client.release();
  }
});

// ---------- PC disponibles ----------
app.get("/api/pcs", auth, (_req, res) => {
  res.json(["94303", "95301", "95303", "234120502", "234120503"]);
});

// ---------- Acumulado día ----------
app.get("/api/acumulado", auth, async (req, res) => {
  const { dni, fecha } = req.query;
  if (!dni || !fecha) return res.status(400).json({ error: "dni y fecha requeridos" });

  const q = `
    SELECT COALESCE(SUM(t.total),0) total FROM (
      SELECT num, MAX(total) total
      FROM historial
      WHERE dni=$1 AND fecha=$2
      GROUP BY num
    ) t
  `;
  const { rows } = await pool.query(q, [dni, fecha]);
  res.json({ total: Number(rows[0]?.total || 0) });
});

// ---------- Planillas ----------
app.post("/api/planillas", auth, async (req, res) => {
  const { dni, fecha, detalles } = req.body || {};
  if (!dni || !fecha || !Array.isArray(detalles) || !detalles.length) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const { rows: ru } = await pool.query("SELECT * FROM usuarios WHERE dni=$1", [
    dni,
  ]);
  const user = ru[0];
  if (!user) return res.status(400).json({ error: "Trabajador no existe" });

  // Tope de 45
  const TOPE = 45.0;
  const { rows: ra } = await pool.query(
    `
    SELECT COALESCE(SUM(t.total),0) total FROM (
      SELECT num, MAX(total) total
      FROM historial
      WHERE dni=$1 AND fecha=$2
      GROUP BY num
    ) t
  `,
    [dni, fecha]
  );
  const acumulado = Number(ra[0]?.total || 0);
  const totalPlanilla = detalles.reduce((s, d) => s + (Number(d.monto) || 0), 0);
  if (acumulado + totalPlanilla > TOPE) {
    return res.status(400).json({
      error: "Tope diario superado",
      acumulado,
      disponible: Math.max(0, TOPE - acumulado),
    });
  }

  const { rows: rc } = await pool.query(
    "SELECT n FROM counters WHERE dni=$1",
    [dni]
  );
  const next = (rc[0]?.n || 0) + 1;
  await pool.query(
    `INSERT INTO counters(dni,n) VALUES($1,$2)
     ON CONFLICT(dni) DO UPDATE SET n=EXCLUDED.n`,
    [dni, next]
  );

  const num = String(next).padStart(5, "0");
  const serie = serieFromName(user.nombres, user.apellidos);

  const ins = `
    INSERT INTO historial
      (serie,num,fecha,dni,email,trabajador,proyecto,destino,motivo,pc,monto,total)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const d of detalles) {
      await client.query(ins, [
        serie,
        num,
        fecha,
        dni,
        user.email,
        `${user.nombres} ${user.apellidos}`,
        d.proyecto || user.proydef || "",
        d.destino || "",
        d.motivo || "",
        d.pc || "",
        Number(d.monto) || 0,
        totalPlanilla,
      ]);
    }
    await client.query("COMMIT");
    res.json({ ok: true, serie, num, total: totalPlanilla });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Error guardando planilla" });
  } finally {
    client.release();
  }
});

// ---------- SPA ----------
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () =>
  console.log(`API corriendo en http://localhost:${PORT}`)
);
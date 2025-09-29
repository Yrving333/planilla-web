import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg"; // <<--- usamos Postgres
const { Pool } = pkg;

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== CONFIG ======
const JWT_SECRET = process.env.JWT_SECRET || "cambia-esto-en-produccion";
const TOPE = 45.0;
const PORT = process.env.PORT || 3000;

// ====== DB POOL (Neon) ======
if (!process.env.DATABASE_URL) {
  console.error("Falta la variable DATABASE_URL");
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requiere SSL
});

// ====== APP ======
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ====== Helpers ======
const normalizar = (t = "") =>
  t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const serieFromName = (n, a) =>
  (n.slice(0, 2) + a.slice(0, 2)).toUpperCase() + "001";

// ====== Init DB (tablas + seed demo) ======
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS empresas (
        id TEXT PRIMARY KEY,
        razon TEXT NOT NULL,
        ruc TEXT NOT NULL,
        direccion TEXT,
        telefono TEXT,
        logo TEXT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        activo INTEGER DEFAULT 1,
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
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS counters (
        dni TEXT PRIMARY KEY,
        n INTEGER NOT NULL DEFAULT 0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS historial (
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
    `);

    // Seed empresas
    const { rows: rowsEmp } = await client.query("SELECT COUNT(*)::int AS c FROM empresas");
    if (rowsEmp[0].c === 0) {
      const direccion = "JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA";
      const tel = "495-1331";
      await client.query(
        `INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        ["INV_PADOVA","INVERSIONES PADOVA S.A.C.","20523824598",direccion,tel,""]
      );
      await client.query(
        `INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        ["CONS_PADOVA","CONSTRUCTORA PADOVA S.A.C.","20601444341",direccion,tel,""]
      );
    }

    // Seed usuarios demo
    const { rows: rowsUsr } = await client.query("SELECT COUNT(*)::int AS c FROM usuarios");
    if (rowsUsr[0].c === 0) {
      const pAdmin = bcrypt.hashSync("admin123", 8);
      const pUser = bcrypt.hashSync("usuario123", 8);
      await client.query(
        `INSERT INTO usuarios(dni,nombres,apellidos,email,empresaId,rol,proyDef,proyectos,password_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        ["44895702","YRVING","LEON","admin@empresa.com","INV_PADOVA","ADMIN_PADOVA","ADMIN PADOVA","ADMIN PADOVA,LITORAL 900,SANTA BEATRIZ",pAdmin]
      );
      await client.query(
        `INSERT INTO usuarios(dni,nombres,apellidos,email,empresaId,rol,proyDef,proyectos,password_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        ["44081950","JOEL","GARGATE","usuario@empresa.com","CONS_PADOVA","USUARIO","SANTA BEATRIZ","SANTA BEATRIZ",pUser]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Error inicializando BD:", e);
    throw e;
  } finally {
    client.release();
  }
}

// ====== Auth middlewares ======
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}
function onlyAdmin(req, res, next) {
  if (req.user?.rol === "ADMIN_PADOVA") return next();
  return res.status(403).json({ error: "Solo administradores" });
}

// ====== Rutas ======

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email requerido" });

  const { rows } = await pool.query(
    "SELECT * FROM usuarios WHERE email = $1 AND activo = 1",
    [String(email).toLowerCase()]
  );
  const u = rows[0];
  if (!u) return res.status(401).json({ error: "Usuario no existe o inactivo" });

  if (u.password_hash) {
    const ok = bcrypt.compareSync(password || "", u.password_hash);
    if (!ok) return res.status(401).json({ error: "Clave incorrecta" });
  }

  const token = jwt.sign(
    { uid: u.id, email: u.email, dni: u.dni, rol: u.rol },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
  res.json({
    token,
    me: {
      email: u.email,
      dni: u.dni,
      rol: u.rol,
      nombres: u.nombres,
      apellidos: u.apellidos,
      empresaId: u.empresaid
    }
  });
});

// Empresas
app.get("/api/empresas", auth, async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM empresas ORDER BY id");
  res.json(rows);
});

app.put("/api/empresas", auth, onlyAdmin, async (req, res) => {
  const list = req.body || [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of list) {
      await client.query(
        `INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           razon=EXCLUDED.razon,
           ruc=EXCLUDED.ruc,
           direccion=EXCLUDED.direccion,
           telefono=EXCLUDED.telefono,
           logo=EXCLUDED.logo`,
        [e.id, e.razon, e.ruc, e.direccion, e.telefono, e.logo || ""]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Error guardando empresas" });
  } finally {
    client.release();
  }
});

// Usuarios
app.get("/api/usuarios", auth, async (req, res) => {
  if (req.user.rol === "ADMIN_PADOVA") {
    const { rows } = await pool.query("SELECT * FROM usuarios ORDER BY apellidos,nombres");
    return res.json(rows);
  }
  const { rows } = await pool.query("SELECT * FROM usuarios WHERE email=$1", [req.user.email]);
  res.json(rows);
});

app.put("/api/usuarios", auth, onlyAdmin, async (req, res) => {
  const list = req.body || [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of list) {
      await client.query(
        `INSERT INTO usuarios(dni,nombres,apellidos,email,empresaId,rol,proyDef,proyectos,activo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (dni) DO UPDATE SET
           nombres=EXCLUDED.nombres,
           apellidos=EXCLUDED.apellidos,
           email=EXCLUDED.email,
           empresaId=EXCLUDED.empresaId,
           rol=EXCLUDED.rol,
           proyDef=EXCLUDED.proyDef,
           proyectos=EXCLUDED.proyectos,
           activo=EXCLUDED.activo`,
        [u.dni, u.nombres, u.apellidos, u.email, u.empresaId, u.rol, u.proyDef, u.proyectos, u.activo ? 1 : 0]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Error guardando usuarios" });
  } finally {
    client.release();
  }
});

// Acumulado por día
app.get("/api/acumulado", auth, async (req, res) => {
  const { dni, fecha } = req.query;
  if (!dni || !fecha) return res.status(400).json({ error: "dni y fecha requeridos" });

  const { rows } = await pool.query(
    `
    SELECT COALESCE(SUM(t.total),0)::float AS total FROM (
      SELECT num, MAX(total) AS total
      FROM historial
      WHERE dni=$1 AND fecha=$2
      GROUP BY num
    ) t
    `,
    [dni, fecha]
  );
  res.json({ total: Number(rows[0]?.total || 0) });
});

// Historial
app.get("/api/historial", auth, async (req, res) => {
  let rows;
  if (req.user.rol === "ADMIN_PADOVA") {
    rows = (await pool.query("SELECT * FROM historial ORDER BY id DESC")).rows;
  } else {
    rows = (await pool.query(
      "SELECT * FROM historial WHERE email=$1 OR dni=$2 ORDER BY id DESC",
      [req.user.email, req.user.dni]
    )).rows;
  }
  res.json(rows);
});

app.put("/api/historial", auth, onlyAdmin, async (req, res) => {
  const list = req.body || [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of list) {
      await client.query(
        `UPDATE historial SET
          serie=$1, num=$2, fecha=$3, trabajador=$4, proyecto=$5,
          destino=$6, motivo=$7, pc=$8, monto=$9, total=$10
         WHERE id=$11`,
        [r.serie, r.num, r.fecha, r.trabajador, r.proyecto, r.destino, r.motivo, r.pc,
         Number(r.monto)||0, Number(r.total)||0, r.id]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Error editando historial" });
  } finally {
    client.release();
  }
});

app.post("/api/historial/delete", auth, onlyAdmin, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: true, deleted: 0 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const id of ids) {
      await client.query("DELETE FROM historial WHERE id=$1", [id]);
    }
    await client.query("COMMIT");
    res.json({ ok: true, deleted: ids.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Error eliminando historial" });
  } finally {
    client.release();
  }
});

// Guardar planilla (tope + correlativo)
app.post("/api/planillas", auth, async (req, res) => {
  const { dni, fecha, detalles } = req.body || {};
  if (!dni || !fecha || !Array.isArray(detalles) || detalles.length === 0) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const { rows: userRows } = await pool.query("SELECT * FROM usuarios WHERE dni=$1", [dni]);
  const user = userRows[0];
  if (!user) return res.status(400).json({ error: "Trabajador no existe" });

  const totalPlanilla = detalles.reduce((s, d) => s + (Number(d.monto) || 0), 0);

  const { rows: accRows } = await pool.query(
    `
    SELECT COALESCE(SUM(t.total),0)::float AS total FROM (
      SELECT num, MAX(total) AS total
      FROM historial
      WHERE dni=$1 AND fecha=$2
      GROUP BY num
    ) t
    `,
    [dni, fecha]
  );
  const acumulado = Number(accRows[0]?.total || 0);
  if (acumulado + totalPlanilla > TOPE) {
    return res.status(400).json({
      error: "Tope diario superado",
      acumulado, disponible: Math.max(0, TOPE - acumulado)
    });
  }

  // correlativo por usuario
  const { rows: cRows } = await pool.query("SELECT n FROM counters WHERE dni=$1", [dni]);
  const next = (cRows[0]?.n || 0) + 1;
  await pool.query(
    `INSERT INTO counters(dni,n) VALUES ($1,$2)
     ON CONFLICT (dni) DO UPDATE SET n=EXCLUDED.n`,
    [dni, next]
  );
  const num = String(next).padStart(5, "0");
  const serie = serieFromName(normalizar(user.nombres), normalizar(user.apellidos));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const d of detalles) {
      await client.query(
        `INSERT INTO historial
          (serie,num,fecha,dni,email,trabajador,proyecto,destino,motivo,pc,monto,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          serie, num, fecha, dni, user.email, `${user.nombres} ${user.apellidos}`,
          d.proyecto || user.proyDef || "", d.destino || "", d.motivo || "", d.pc || "",
          Number(d.monto) || 0, totalPlanilla
        ]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, serie, num, total: totalPlanilla });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Error guardando planilla" });
  } finally {
    client.release();
  }
});

// PCs disponibles
app.get("/api/pcs", auth, (_req, res) => {
  res.json(["94303", "95301", "95303", "234120502", "234120503"]);
});

// SPA
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ====== Arranque ======
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Fallo init DB:", e);
    process.exit(1);
  });

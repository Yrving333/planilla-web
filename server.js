// server.js
// Planilla de Movilidad - Backend Express + Postgres (Neon)
// © 2025

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

// ------------------------- Config -------------------------
const TOPE_DIA = 45.0;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sirve frontend (público)
app.use(express.static(path.join(__dirname, "public")));

// --------------------- Utilidades SQL ---------------------
async function ensureSchema() {
  // Empresas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      razon TEXT,
      ruc   TEXT,
      direccion TEXT,
      telefono TEXT,
      logo   TEXT
    );
  `);

  // Usuarios
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      dni    VARCHAR(8) UNIQUE NOT NULL,
      nombres   TEXT NOT NULL,
      apellidos TEXT NOT NULL,
      email     TEXT UNIQUE NOT NULL,
      empresaid TEXT NOT NULL REFERENCES empresas(id),
      rol       TEXT NOT NULL,
      proydef   TEXT,
      proys     TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Contadores por DNI
  await pool.query(`
    CREATE TABLE IF NOT EXISTS counters (
      dni VARCHAR(8) PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Historial de planillas (un registro por ítem/monto)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historial (
      id SERIAL PRIMARY KEY,
      serie TEXT NOT NULL,
      num   TEXT NOT NULL,
      fecha DATE NOT NULL,
      dni   VARCHAR(8) NOT NULL,
      email TEXT,
      trabajador TEXT NOT NULL,
      proyecto   TEXT,
      destino    TEXT,
      motivo     TEXT,
      pc         TEXT,
      monto      NUMERIC(12,2) NOT NULL,
      total      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Semilla mínima (si no existen)
  const { rows: rEmp } = await pool.query(`SELECT COUNT(*)::int AS c FROM empresas;`);
  if (rEmp[0].c === 0) {
    await pool.query(
      `INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
       VALUES
       ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331',''),
       ('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331','')`
    );
  }

  const { rows: rUsr } = await pool.query(`SELECT COUNT(*)::int AS c FROM usuarios;`);
  if (rUsr[0].c === 0) {
    await pool.query(
      `INSERT INTO usuarios(activo,dni,nombres,apellidos,email,empresaid,rol,proydef,proys)
       VALUES
       (TRUE,'44895702','YRVING','LEON','admin@empresa.com','INV_PADOVA','ADMIN_PADOVA','ADMIN PADOVA','ADMIN PADOVA,LITORAL 900,SANTA BEATRIZ'),
       (TRUE,'44081950','JOEL','GARGATE','usuario@empresa.com','CONS_PADOVA','USUARIO','SANTA BEATRIZ','SANTA BEATRIZ')`
    );
  }
}

// Serie basada en nombre y apellido (2+2) + "001"
function serieDesde(nombres = "", apellidos = "") {
  const norm = (s) =>
    (s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();
  const n = norm(nombres).slice(0, 2);
  const a = norm(apellidos).slice(0, 2);
  return `${n}${a}001`;
}

// Padded 5
const pad5 = (n) => String(n).padStart(5, "0");

// ------------------------ Endpoints ------------------------

// Salud
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------- Empresas
app.get("/api/empresas", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id,razon,ruc,direccion,telefono,logo FROM empresas ORDER BY id"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "empresas list", details: String(e) });
  }
});

// Guarda/actualiza empresas (upsert simple)
app.post("/api/empresas/save", async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of list) {
      await client.query(
        `INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
         VALUES($1,$2,$3,$4,$5,$6)
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
    res.status(500).json({ error: "empresas save", details: String(e) });
  } finally {
    client.release();
  }
});

// -------- Usuarios
// Lista (puede filtrar por email; si ?withEmpresa=1 incluye datos de empresa)
app.get("/api/usuarios", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().toLowerCase();
    const withEmpresa = req.query.withEmpresa === "1";
    let sql = `
      SELECT u.id,u.activo,u.dni,u.nombres,u.apellidos,u.email,u.empresaid,u.rol,u.proydef,u.proys
      ${withEmpresa ? ", e.razon AS empresa_razon, e.ruc, e.direccion, e.telefono, e.logo" : ""}
      FROM usuarios u
      ${withEmpresa ? "LEFT JOIN empresas e ON e.id=u.empresaid" : ""}
    `;
    const params = [];
    if (email) {
      sql += " WHERE LOWER(u.email)=$1";
      params.push(email);
    }
    sql += " ORDER BY u.apellidos,u.nombres";
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "usuarios list", details: String(e) });
  }
});

// Guarda/actualiza usuarios (upsert por email)
// Si cambia el DNI, traslada el contador.
app.post("/api/usuarios/save", async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const u of list) {
      // Busca usuario existente por email
      const { rows: ex } = await client.query(
        "SELECT id,dni FROM usuarios WHERE LOWER(email)=LOWER($1)",
        [u.email]
      );
      if (ex.length) {
        const prevDni = ex[0].dni;
        await client.query(
          `UPDATE usuarios SET
             activo=$1,dni=$2,nombres=$3,apellidos=$4,empresaid=$5,rol=$6,proydef=$7,proys=$8
           WHERE id=$9`,
          [
            !!u.activo,
            u.dni,
            u.nombres,
            u.apellidos,
            u.empresaid,
            u.rol,
            u.proydef || "",
            (u.proys || u.proyectos || "").toString(),
            ex[0].id,
          ]
        );
        if (prevDni !== u.dni) {
          // Mueve contador
          const { rows: cPrev } = await client.query(
            "SELECT seq FROM counters WHERE dni=$1",
            [prevDni]
          );
          const seqPrev = cPrev[0]?.seq || 0;
          await client.query(
            "INSERT INTO counters(dni,seq) VALUES($1,$2) ON CONFLICT (dni) DO NOTHING",
            [u.dni, seqPrev]
          );
          await client.query("DELETE FROM counters WHERE dni=$1", [prevDni]);
        }
      } else {
        // Inserta nuevo
        await client.query(
          `INSERT INTO usuarios(activo,dni,nombres,apellidos,email,empresaid,rol,proydef,proys)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            !!u.activo,
            u.dni,
            u.nombres,
            u.apellidos,
            u.email.toLowerCase(),
            u.empresaid,
            u.rol,
            u.proydef || "",
            (u.proys || u.proyectos || "").toString(),
          ]
        );
        await client.query(
          "INSERT INTO counters(dni,seq) VALUES($1,0) ON CONFLICT (dni) DO NOTHING",
          [u.dni]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "usuarios save", details: String(e) });
  } finally {
    client.release();
  }
});

// -------- Historial
// Lista (si no es admin, filtra por email/dni)
app.get("/api/historial", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().toLowerCase();
    const dni = (req.query.dni || "").toString();
    const admin = req.query.admin === "1";

    let sql = "SELECT * FROM historial";
    const params = [];
    if (!admin) {
      if (email) {
        sql += " WHERE LOWER(email)=$1";
        params.push(email);
      } else if (dni) {
        sql += " WHERE dni=$1";
        params.push(dni);
      } else {
        // sin filtros y no admin: nada
        return res.json([]);
      }
    }
    sql += " ORDER BY id DESC";
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "historial list", details: String(e) });
  }
});

// Edita filas de historial (admin)
app.put("/api/historial", async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `UPDATE historial SET
           serie=$1, num=$2, fecha=$3, trabajador=$4, proyecto=$5,
           destino=$6, motivo=$7, pc=$8, monto=$9, total=$10
         WHERE id=$11`,
        [
          r.serie,
          r.num,
          r.fecha,
          r.trabajador,
          r.proyecto,
          r.destino,
          r.motivo,
          r.pc,
          Number(r.monto) || 0,
          Number(r.total) || 0,
          r.id,
        ]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "historial edit", details: String(e) });
  } finally {
    client.release();
  }
});

// Elimina filas por IDs (admin)
app.delete("/api/historial", async (req, res) => {
  const ids = (req.query.ids || "")
    .toString()
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Boolean);
  if (ids.length === 0) return res.json({ ok: true });

  try {
    await pool.query(`DELETE FROM historial WHERE id = ANY($1::int[])`, [ids]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "historial delete", details: String(e) });
  }
});

// -------- Correlativo por DNI (si no hay fila, la crea)
app.get("/api/counters/next", async (req, res) => {
  try {
    const dni = (req.query.dni || "").toString();
    if (!dni) return res.status(400).json({ error: "dni requerido" });

    await pool.query(
      "INSERT INTO counters(dni,seq) VALUES($1,0) ON CONFLICT (dni) DO NOTHING",
      [dni]
    );
    const { rows } = await pool.query(
      "SELECT seq FROM counters WHERE dni=$1",
      [dni]
    );
    const next = pad5((rows[0]?.seq || 0) + 1);
    res.json({ next });
  } catch (e) {
    console.error("COUNTERS NEXT", e);
    res.status(500).json({ error: "counters next", details: String(e) });
  }
});

// -------- Guardar planilla (transacción + tope diario)
app.post("/api/planillas", async (req, res) => {
  const { dni, email, nombres, apellidos, fecha, detalles = [] } = req.body || {};
  if (!dni || !fecha || !Array.isArray(detalles) || detalles.length === 0) {
    return res.status(400).json({ error: "datos incompletos" });
  }

  const totalPlanilla = detalles.reduce(
    (s, d) => s + (Number(d.monto) || 0),
    0
  );
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Suma del día actual para ese DNI (evitando duplicados por serie-num)
    const { rows: rAcum } = await client.query(
      `SELECT COALESCE(SUM(DISTINCT total),0) AS acum
       FROM historial
       WHERE dni=$1 AND fecha=$2`,
      [dni, fecha]
    );
    const acumulado = Number(rAcum[0]?.acum || 0);

    if (acumulado + totalPlanilla > TOPE_DIA) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "tope_superado",
        acumulado,
        disponible: Math.max(0, TOPE_DIA - acumulado),
        tope: TOPE_DIA,
      });
    }

    // Asegura fila en counters y calcula próximo número
    await client.query(
      `INSERT INTO counters(dni,seq) VALUES($1,0)
       ON CONFLICT (dni) DO NOTHING`,
      [dni]
    );
    const { rows: rc } = await client.query(
      "SELECT seq FROM counters WHERE dni=$1",
      [dni]
    );
    const next = (Number(rc[0]?.seq || 0) + 1);
    await client.query("UPDATE counters SET seq=$1 WHERE dni=$2", [next, dni]);

    const serie = serieDesde(nombres, apellidos);
    const num = pad5(next);
    const trabajador = `${(nombres || "").toUpperCase()} ${(apellidos || "")
      .toUpperCase()
      .trim()}`;

    for (const d of detalles) {
      if (!d || Number(d.monto) <= 0) continue;
      await client.query(
        `INSERT INTO historial
         (serie,num,fecha,dni,email,trabajador,proyecto,destino,motivo,pc,monto,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          serie,
          num,
          fecha,
          dni,
          (email || "").toLowerCase(),
          trabajador,
          (d.proyecto || "").toUpperCase(),
          (d.destino || "").toUpperCase(),
          (d.motivo || "").toUpperCase(),
          (d.pc || "").toString(),
          Number(d.monto) || 0,
          totalPlanilla,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, serie, num, total: totalPlanilla });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("PLANILLAS SAVE", e);
    res.status(500).json({ error: "planillas save", details: String(e) });
  } finally {
    client.release();
  }
});

// ------------------ Catch-all frontend --------------------
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ------------------------- Arranque ------------------------
const PORT = process.env.PORT || 10000;

(async () => {
  try {
    await ensureSchema(); // <-- IMPORTANTE: esperar schema
    app.listen(PORT, () => {
      console.log(`API corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Fallo al crear schema", err);
    process.exit(1);
  }
})();
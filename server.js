// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();

const TOPE_DIA = 45;         // tope de S/45 por día/usuario
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
function serieFromName(nombres, apellidos) {
  const norm = (t) =>
    (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const a = (norm(nombres).trim().toUpperCase() || "XX").slice(0, 2);
  const b = (norm(apellidos).trim().toUpperCase() || "YY").slice(0, 2);
  return `${a}${b}001`;
}

async function getEmpresaById(id) {
  const { rows } = await pool.query("SELECT * FROM empresas WHERE id=$1", [id]);
  return rows[0] || null;
}

// ---------- login ----------
app.get("/api/login", async (req, res) => {
  try {
    const email = (req.query.email || "").toLowerCase();
    const { rows } = await pool.query(
      "SELECT activo, dni, nombres, apellidos, email, empresaid, rol, proydef, proyectos FROM usuarios WHERE LOWER(email)=$1",
      [email]
    );
    const u = rows[0];
    if (!u || !u.activo) return res.status(400).json({ error: "Usuario no existe o inactivo" });
    // normaliza array
    if (typeof u.proyectos === "string") u.proyectos = u.proyectos.split(",").map(s => s.trim()).filter(Boolean);
    res.json(u);
  } catch (e) { res.status(500).json({ error: "login error" }); }
});

// ---------- empresas ----------
app.get("/api/empresas", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM empresas ORDER BY id");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: "empresas get" }); }
});
app.put("/api/empresas", async (req, res) => {
  try {
    const list = req.body || [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM empresas");
      for (const e of list) {
        await client.query(
          "INSERT INTO empresas(id, razon, ruc, direccion, telefono, logo) VALUES($1,$2,$3,$4,$5,$6)",
          [e.id, e.razon, e.ruc, e.direccion, e.telefono, e.logo || ""]
        );
      }
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ error: "empresas put" }); }
});

// ---------- usuarios ----------
app.get("/api/usuarios", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM usuarios ORDER BY apellidos, nombres");
    rows.forEach(r=>{
      if (typeof r.proyectos === "string") r.proyectos = r.proyectos.split(",").map(s=>s.trim()).filter(Boolean);
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: "usuarios get" }); }
});
app.put("/api/usuarios", async (req, res) => {
  try {
    const list = req.body || [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM usuarios");
      for (const u of list) {
        await client.query(
          `INSERT INTO usuarios(activo,dni,nombres,apellidos,empresaid,rol,proydef,proyectos,email)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            !!u.activo, u.dni, u.nombres, u.apellidos, u.empresaid,
            u.rol, u.proydef || u.proyDef || "", (u.proyectos || []).join(", "),
            (u.email || "").toLowerCase()
          ]
        );
      }
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ error: "usuarios put" }); }
});

// crear/editar desde modal
app.put("/api/usuarios/modal", async (req, res) => {
  try {
    const { edit, from, record } = req.body || {};
    if (edit) {
      // actualizar por dni 'from'
      await pool.query(
        `UPDATE usuarios SET dni=$1, nombres=$2, apellidos=$3, empresaid=$4, rol=$5, proydef=$6, proyectos=$7, email=$8
         WHERE dni=$9`,
        [record.dni, record.nombres, record.apellidos, record.empresaid, record.rol,
         record.proydef, (record.proyectos||[]).join(", "), (record.email||"").toLowerCase(),
         from]
      );
    } else {
      await pool.query(
        `INSERT INTO usuarios(activo,dni,nombres,apellidos,empresaid,rol,proydef,proyectos,email)
         VALUES(true,$1,$2,$3,$4,$5,$6,$7,$8)`,
        [record.dni, record.nombres, record.apellidos, record.empresaid, record.rol,
         record.proydef, (record.proyectos||[]).join(", "), (record.email||"").toLowerCase()]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "usuarios modal" }); }
});

// ---------- historial ----------
app.get("/api/historial", async (req, res) => {
  try {
    const scope = req.query.scope || "mine"; // all|mine
    let rows;
    if (scope === "all") {
      ({ rows } = await pool.query("SELECT * FROM historial ORDER BY id"));
    } else {
      // Por simplicidad devuelve todo; el front ya filtra por sesión si hiciera falta
      ({ rows } = await pool.query("SELECT * FROM historial ORDER BY id"));
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: "historial get" }); }
});

app.put("/api/historial", async (req, res) => {
  try {
    const changes = req.body || [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of changes) {
        await client.query(
          `UPDATE historial SET serie=$1,num=$2,fecha=$3,trabajador=$4,proyecto=$5,destino=$6,motivo=$7,pc=$8,monto=$9,total=$10
           WHERE id=$11`,
          [r.serie,r.num,r.fecha,r.trabajador,r.proyecto,r.destino,r.motivo,r.pc,r.monto,r.total,r.id]
        );
      }
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ error: "historial put" }); }
});

app.delete("/api/historial", async (req, res) => {
  try {
    const ids = req.body?.ids || [];
    if(!ids.length) return res.json({ ok:true, deleted:0 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM historial WHERE id = ANY($1)", [ids]);
      await client.query("COMMIT");
      res.json({ ok: true, deleted: ids.length });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ error: "historial delete" }); }
});

// acumulado por día/usuario (suma por planilla distinta)
app.get("/api/historial/acumulado", async (req, res) => {
  try {
    const { dni, fecha } = req.query;
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS s
       FROM (
         SELECT DISTINCT ON (serie,num) total
         FROM historial
         WHERE dni=$1 AND fecha=$2
         ORDER BY serie,num,id DESC
       ) t`,
      [dni, fecha]
    );
    res.json({ acumulado: Number(rows[0]?.s || 0) });
  } catch (e) { res.status(500).json({ error: "acumulado get" }); }
});

// ---------- admin pin ----------
app.post("/api/admin/pin", (req,res)=>{
  const ok = (req.body?.pin || "") === ADMIN_PIN;
  res.json({ ok });
});

// ---------- guardar planilla con tope ----------
app.post("/api/planillas", async (req, res) => {
  const client = await pool.connect();
  try {
    const { dni, email, fecha, items } = req.body || {};
    if (!dni || !fecha || !Array.isArray(items) || items.length===0)
      return res.status(400).json({ error: "Datos incompletos" });

    // usuario + empresa
    const { rows:ru } = await client.query(
      "SELECT * FROM usuarios WHERE dni=$1 LIMIT 1", [dni]
    );
    const u = ru[0];
    if (!u) return res.status(400).json({ error: "Usuario no existe" });

    // acumulado del día (por planilla distinta)
    const { rows:rac } = await client.query(
      `SELECT COALESCE(SUM(total),0) AS s
       FROM (
         SELECT DISTINCT ON (serie,num) total
         FROM historial WHERE dni=$1 AND fecha=$2
         ORDER BY serie,num,id DESC
       ) t`,
      [dni, fecha]
    );
    const acumulado = Number(rac[0]?.s || 0);
    const totalNuevo = items.reduce((s,i)=>s + Number(i.monto||0), 0);
    if (acumulado + totalNuevo > TOPE_DIA) {
      return res.status(409).json({
        error: "Tope diario S/45 superado",
        remaining: Math.max(0, TOPE_DIA - acumulado)
      });
    }

    // generar serie y numeración por DNI
    await client.query("BEGIN");
    await client.query(
      `CREATE TABLE IF NOT EXISTS counters(
         dni TEXT PRIMARY KEY,
         seq INTEGER NOT NULL DEFAULT 0
       )`
    );
    const { rows:rc } = await client.query(
      `INSERT INTO counters(dni, seq) VALUES($1, 0)
       ON CONFLICT (dni) DO UPDATE SET seq=counters.seq
       RETURNING seq`, [dni]
    );
    const next = Number(rc[0].seq) + 1;
    await client.query("UPDATE counters SET seq=$1 WHERE dni=$2", [next, dni]);

    const serie = serieFromName(u.nombres, u.apellidos);
    const num = String(next).padStart(5,"0");

    // insertar historial (una fila por item con el total de la planilla)
    const totalPlanilla = totalNuevo;
    for (const it of items) {
      await client.query(
        `INSERT INTO historial(serie,num,fecha,dni,email,trabajador,proyecto,destino,motivo,pc,monto,total)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          serie, num, fecha, dni, (email||"").toLowerCase(),
          `${u.nombres} ${u.apellidos}`,
          it.proyecto || (u.proydef || u.proyDef || ""),
          it.destino, it.motivo, it.pc, Number(it.monto||0), totalPlanilla
        ]
      );
    }
    await client.query("COMMIT");

    // devolver empresa (para PDF)
    const emp = await getEmpresaById(u.empresaid);
    res.json({ ok:true, serie, num, total: totalPlanilla, empresa: emp });
  } catch (e) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: "planilla post" });
  } finally { client.release(); }
});

// ---------- SPA ----------
app.get("*", (_req,res)=>{
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`API corriendo en http://localhost:${PORT}`));

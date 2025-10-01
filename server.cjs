// server.cjs
// Planilla de Movilidad – API
// Node 20, Express, PostgreSQL (pg)

import express from "express";
import cors from "cors";
import pkg from "pg";
const { Pool } = pkg;

const PORT = process.env.PORT || 1000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const TOPE = parseFloat(process.env.TOPE || "45");

if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

// ---------- Helpers ----------
async function q(query, params = []) {
  const c = await pool.connect();
  try {
    const r = await c.query(query, params);
    return r;
  } finally {
    c.release();
  }
}

function toBool(any) {
  const s = (any ?? "").toString().toLowerCase();
  return s === "1" || s === "t" || s === "true" || s === "y";
}

function serieFromNombreApellidos(nombres = "", apellidos = "") {
  const n = (nombres || "").trim().toUpperCase();
  const a = (apellidos || "").trim().toUpperCase();
  const sn = n ? n[0] : "X";
  const sa = a ? a[0] : "X";
  return sn + sa;
}

function pad5(n) {
  return String(n).padStart(5, "0");
}

// ---------- Bootstrap seguro ----------
async function bootstrap() {
  // tablas base
  await q(`
  BEGIN;

  CREATE TABLE IF NOT EXISTS empresas(
    id         TEXT PRIMARY KEY,
    razon      TEXT NOT NULL,
    ruc        TEXT,
    direccion  TEXT,
    telefono   TEXT,
    logo       TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS pcs(
    codigo     TEXT NOT NULL,
    empresaid  TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    PRIMARY KEY (codigo, empresaid)
  );

  CREATE TABLE IF NOT EXISTS usuarios(
    email      TEXT PRIMARY KEY,
    dni        TEXT NOT NULL,
    nombres    TEXT NOT NULL,
    apellidos  TEXT NOT NULL,
    rol        TEXT NOT NULL,        -- ADMIN_PADOVA / USUARIO
    activo     TEXT DEFAULT '1',     -- puede venir como '1','t','true' (compatibilidad)
    empresaid  TEXT NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    proydef    TEXT,
    proys      TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- correlativo por usuario (dni)
  CREATE TABLE IF NOT EXISTS counters(
    dni TEXT PRIMARY KEY,
    n   INTEGER NOT NULL DEFAULT 0
  );

  -- historial de planillas
  CREATE TABLE IF NOT EXISTS historial(
    id         BIGSERIAL PRIMARY KEY,
    dni        TEXT NOT NULL,
    email      TEXT NOT NULL,
    fecha      DATE NOT NULL,
    serie      TEXT NOT NULL,
    num        INTEGER NOT NULL,
    empresaid  TEXT NOT NULL,
    total      NUMERIC(12,2) NOT NULL DEFAULT 0,
    items      JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(dni, serie, num)
  );

  COMMIT;
  `);

  // vista de login (corrige "IS TRUE must be type boolean")
  await q(`
  CREATE OR REPLACE VIEW v_usuarios_login AS
  SELECT
    email,
    dni,
    nombres,
    apellidos,
    rol,
    CASE
      WHEN COALESCE(activo,'')::TEXT IN ('1','t','true','TRUE') THEN TRUE
      ELSE FALSE
    END AS activo,
    empresaid,
    proydef,
    COALESCE(proys,'{}'::TEXT[]) AS proys
  FROM usuarios;
  `);

  // datos mínimos
  await q(`
  INSERT INTO empresas(id, razon, ruc, direccion, telefono)
  VALUES
   ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331'),
   ('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331')
  ON CONFLICT(id) DO NOTHING;
  `);

  await q(`
  INSERT INTO pcs(codigo,empresaid) VALUES
   ('94303','INV_PADOVA'),
   ('94601','INV_PADOVA'),
   ('94303','CONS_PADOVA')
  ON CONFLICT DO NOTHING;
  `);

  await q(`
  INSERT INTO usuarios(email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys)
  VALUES
   ('admin@empresa.com','44895702','YRVING','LEON','ADMIN_PADOVA','1','INV_PADOVA','ADMIN PADOVA',ARRAY['ADMIN PADOVA','LITORAL 900']),
   ('usuario@empresa.com','44081950','JOEL','GARGATE','USUARIO','1','CONS_PADOVA','SANTA BEATRIZ',ARRAY['SANTA BEATRIZ'])
  ON CONFLICT(email) DO NOTHING;
  `);
}

// ---------- API ----------
app.get("/api/version", (req,res)=> res.json({ ok:true, tope: TOPE }));

// login por email
app.get("/api/login", async (req,res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email requerido" });
    const r = await q(`SELECT * FROM v_usuarios_login WHERE LOWER(email)=LOWER($1)`, [email]);
    if (!r.rowCount) return res.status(404).json({ error: "no encontrado" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "login error" });
  }
});

// empresas
app.get("/api/empresas", async (req,res)=>{
  try{
    const simple = String(req.query.simple||"");
    const cols = simple ? "id,razon,ruc,direccion,telefono" : "id,razon,ruc,direccion,telefono,logo";
    const r = await q(`SELECT ${cols} FROM empresas ORDER BY id`);
    res.json(r.rows);
  }catch(e){ console.error(e); res.status(500).json({error:"empresas error"}); }
});

// PCs por empresa
app.get("/api/pcs", async (req,res)=>{
  try{
    const emp = String(req.query.emp||"").trim();
    if (!emp) return res.json([]);
    const r = await q(`SELECT codigo FROM pcs WHERE empresaid=$1 ORDER BY codigo`, [emp]);
    res.json(r.rows.map(x=>x.codigo));
  }catch(e){ console.error(e); res.status(500).json({error:"pcs error"}); }
});

// usuarios (para llenar selector)
app.get("/api/usuarios", async (req,res)=>{
  try{
    const r = await q(`SELECT * FROM v_usuarios_login ORDER BY email`);
    res.json(r.rows);
  }catch(e){ console.error(e); res.status(500).json({error:"usuarios error"}); }
});

// acumulado del día por dni
app.get("/api/acumulado", async (req,res)=>{
  try{
    const dni = String(req.query.dni||"").trim();
    const fecha = String(req.query.fecha||"").trim(); // YYYY-MM-DD
    if(!dni || !fecha) return res.json({ acumulado: 0 });
    const r = await q(`SELECT COALESCE(SUM(total),0) AS s FROM historial WHERE dni=$1 AND fecha=$2`, [dni, fecha]);
    res.json({ acumulado: Number(r.rows[0].s) });
  }catch(e){ console.error(e); res.status(500).json({error:"acumulado error"}); }
});

// historial (usuario ve lo suyo; admin ve todo si ?all=1)
app.get("/api/historial", async (req,res)=>{
  try{
    const email = String(req.query.email||"").trim().toLowerCase();
    const all = String(req.query.all||"") === "1";
    let rows;
    if (all) {
      rows = (await q(`SELECT * FROM historial ORDER BY created_at DESC LIMIT 200`)).rows;
    } else {
      if(!email) return res.json([]);
      rows = (await q(`SELECT * FROM historial WHERE LOWER(email)=LOWER($1) ORDER BY created_at DESC LIMIT 100`, [email])).rows;
    }
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json({error:"historial error"}); }
});

// crear planilla
app.post("/api/planillas", async (req,res)=>{
  try{
    const { dni, email, fecha, items } = req.body || {};
    if (!dni || !email || !fecha || !Array.isArray(items)) {
      return res.status(400).json({ error: "payload inválido" });
    }

    // usuario (para empresaid y nombres)
    const u = (await q(`SELECT * FROM v_usuarios_login WHERE LOWER(email)=LOWER($1)`, [email])).rows[0];
    if (!u || !u.activo) return res.status(403).json({ error: "usuario inactivo/no válido" });

    const totalItems = Number(items.reduce((acc, it) => acc + Number(it?.monto||0), 0).toFixed(2));
    // acumulado del día
    const rAcc = await q(`SELECT COALESCE(SUM(total),0) AS s FROM historial WHERE dni=$1 AND fecha=$2`, [dni, fecha]);
    const acumulado = Number(rAcc.rows[0].s);

    if (acumulado + totalItems > TOPE + 0.0001) {
      return res.status(400).json({
        error: `Se supera el tope diario de S/ ${TOPE.toFixed(2)}. Acumulado: S/ ${acumulado.toFixed(2)}. Intento: S/ ${totalItems.toFixed(2)}.`
      });
    }

    const serie = serieFromNombreApellidos(u.nombres, u.apellidos);

    // asegurar contador
    await q(`INSERT INTO counters(dni,n) VALUES($1,0) ON CONFLICT(dni) DO NOTHING`, [dni]);
    const up = await q(`UPDATE counters SET n = n + 1 WHERE dni=$1 RETURNING n`, [dni]);
    const n = up.rows[0].n;             // entero
    const num = n;                       // entero guardado
    const numStr = pad5(n);              // string para mostrar

    // insertar historial
    const ins = await q(
      `INSERT INTO historial(dni,email,fecha,serie,num,empresaid,total,items)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [dni, email, fecha, serie, num, u.empresaid, totalItems, JSON.stringify(items)]
    );

    // empresa para PDF
    const emp = (await q(`SELECT id,razon,ruc,direccion,telefono FROM empresas WHERE id=$1`, [u.empresaid])).rows[0] || null;

    res.json({
      ok: true,
      fecha,
      total: totalItems,
      serie,
      num: numStr,
      empresa: emp,
      u: { nombres: u.nombres, apellidos: u.apellidos, dni: u.dni, proydef: u.proydef }
    });

  }catch(e){
    console.error("POST /api/planillas error:", e);
    res.status(500).json({ error: "error guardando planilla" });
  }
});

// validar pin admin
app.post("/api/admin/pin", (req,res)=>{
  const { pin } = req.body || {};
  if (String(pin) === String(ADMIN_PIN)) return res.json({ ok:true });
  return res.status(401).json({ ok:false, error:"PIN inválido" });
});

// (Opcional) actualizar tablas desde Admin (requiere X-ADMIN-PIN)
// PUT /api/admin/empresas  body: { empresas: [ {...} ] }
app.put("/api/admin/empresas", async (req,res)=>{
  try{
    const pin = req.headers["x-admin-pin"];
    if (String(pin)!==String(ADMIN_PIN)) return res.status(401).json({error:"PIN requerido"});
    const { empresas=[] } = req.body||{};
    const c = await pool.connect();
    try{
      await c.query("BEGIN");
      for(const e of empresas){
        await c.query(`
          INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
          VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(id) DO UPDATE SET
            razon=EXCLUDED.razon, ruc=EXCLUDED.ruc, direccion=EXCLUDED.direccion,
            telefono=EXCLUDED.telefono, logo=EXCLUDED.logo
        `, [e.id, e.razon, e.ruc, e.direccion, e.telefono, e.logo||null]);
      }
      await c.query("COMMIT");
    }catch(e){ await c.query("ROLLBACK"); throw e; }
    finally{ c.release(); }
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:"admin empresas error"}); }
});

// PUT /api/admin/usuarios  body: { usuarios: [ {...} ] }
app.put("/api/admin/usuarios", async (req,res)=>{
  try{
    const pin = req.headers["x-admin-pin"];
    if (String(pin)!==String(ADMIN_PIN)) return res.status(401).json({error:"PIN requerido"});
    const { usuarios=[] } = req.body||{};
    const c = await pool.connect();
    try{
      await c.query("BEGIN");
      for(const u of usuarios){
        await c.query(`
          INSERT INTO usuarios(email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(email) DO UPDATE SET
            dni=EXCLUDED.dni, nombres=EXCLUDED.nombres, apellidos=EXCLUDED.apellidos,
            rol=EXCLUDED.rol, activo=EXCLUDED.activo, empresaid=EXCLUDED.empresaid,
            proydef=EXCLUDED.proydef, proys=EXCLUDED.proys
        `, [u.email, u.dni, u.nombres, u.apellidos, u.rol, String(u.activo??'1'), u.empresaid, u.proydef, u.proys||[] ]);
      }
      await c.query("COMMIT");
    }catch(e){ await c.query("ROLLBACK"); throw e; }
    finally{ c.release(); }
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:"admin usuarios error"}); }
});

app.listen(PORT, async ()=>{
  try{
    await bootstrap();
    console.log("API lista en :"+PORT, " — TOPE:", TOPE);
  }catch(e){
    console.error("Bootstrap error", e);
    process.exit(1);
  }
});

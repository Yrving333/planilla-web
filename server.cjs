// server.cjs
// API Planilla de Movilidad (Node + Express + PostgreSQL/Neon)
// ENV requeridas en Render:
// - DATABASE_URL (Neon, con SSL) | - CORS_ORIGIN (opcional) | - PORT (opcional)
// - ADMIN_PIN (opcional, default '1234') | - TOPE (opcional, default 45.00)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const TOPE = Number(process.env.TOPE || 45);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s=>s.trim()) : true,
  credentials: true
}));

// ---- Helpers ----
const q = (text, params=[]) => pool.query(text, params);
const pad = (n, w=5) => String(n).padStart(w, '0');
const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
const serieFromName = (nombres='', apellidos='') =>
  (norm(nombres).slice(0,2) + norm(apellidos).slice(0,2) + '001');

// ---- Bootstrap DB (tablas y vista) ----
async function bootstrap() {
  await q(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      razon TEXT NOT NULL,
      ruc TEXT,
      direccion TEXT,
      telefono TEXT,
      logo TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      email TEXT PRIMARY KEY,
      dni TEXT UNIQUE,
      nombres TEXT NOT NULL,
      apellidos TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USUARIO',
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      empresaid TEXT REFERENCES empresas(id),
      proydef TEXT,
      proys TEXT[] DEFAULT '{}',
      correlativo INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS counters (
      dni TEXT PRIMARY KEY,
      n INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS historial (
      id SERIAL PRIMARY KEY,
      dni TEXT,
      email TEXT,
      fecha TEXT,
      serie TEXT,
      num TEXT,
      trabajador TEXT,
      proyecto TEXT,
      destino TEXT,
      motivo TEXT,
      pc TEXT,
      monto NUMERIC(12,2) DEFAULT 0,
      total NUMERIC(12,2) DEFAULT 0,
      empresaid TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE OR REPLACE VIEW v_usuarios_login AS
    SELECT
      email,
      dni,
      nombres,
      apellidos,
      (activo IS TRUE) AS activo,
      role AS rol,
      empresaid,
      proydef,
      COALESCE(proys,'{}') AS proys
    FROM usuarios;
  `);

  // Seed mínimo si está vacío (admin y un usuario demo)
  const { rows } = await q(`SELECT 1 FROM usuarios LIMIT 1`);
  if (!rows.length) {
    await q(`
      INSERT INTO empresas (id, razon, ruc, direccion, telefono)
      VALUES
      ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331'),
      ('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331')
      ON CONFLICT (id) DO NOTHING;
    `);

    await q(`
      INSERT INTO usuarios (email,dni,nombres,apellidos,role,activo,empresaid,proydef,proys)
      VALUES
      ('admin@empresa.com','44895702','YRVING','LEON','ADMIN_PADOVA',true,'INV_PADOVA','ADMIN PADOVA','{}'),
      ('usuario@empresa.com','44081950','JOEL','GARGATE','USUARIO',true,'CONS_PADOVA','SANTA BEATRIZ','{"SANTA BEATRIZ"}')
      ON CONFLICT (email) DO NOTHING;
    `);
  }
}

// ---- Endpoints ----

// Salud
app.get('/api/health', async (_req,res)=> res.json({ok:true, now:new Date().toISOString()}));

// Login (by email, case-insensitive)
app.get('/api/login', async (req, res) => {
  try {
    const email = String(req.query.email||'').toLowerCase();
    if (!email) return res.status(400).json(null);
    const r = await q(`SELECT * FROM v_usuarios_login WHERE email ILIKE $1 LIMIT 1`, [email]);
    const u = r.rows[0];
    if (!u) return res.json(null);
    // Front exige 'activo' y 'rol'
    res.json({
      email: u.email,
      nombres: u.nombres,
      apellidos: u.apellidos,
      dni: u.dni,
      rol: u.rol,
      activo: !!u.activo,
      empresaid: u.empresaid,
      proydef: u.proydef,
      proys: u.proys || []
    });
  } catch (e) {
    console.error(e);
    res.status(500).json(null);
  }
});

// Empresas
app.get('/api/empresas', async (_req,res)=>{
  try{
    const { rows } = await q(`SELECT id,razon,ruc,direccion,telefono,logo FROM empresas ORDER BY razon`);
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json([]); }
});

app.put('/api/empresas', async (req,res)=>{
  try{
    const list = Array.isArray(req.body) ? req.body : [];
    for (const e of list){
      await q(`
        INSERT INTO empresas (id,razon,ruc,direccion,telefono,logo)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET
          razon=$2, ruc=$3, direccion=$4, telefono=$5, logo=$6
      `,[e.id, e.razon, e.ruc||null, e.direccion||null, e.telefono||null, e.logo||null]);
    }
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({ok:false}); }
});

// Usuarios
app.get('/api/usuarios', async (_req,res)=>{
  try{
    const { rows } = await q(`
      SELECT email,dni,nombres,apellidos,role AS rol,activo,empresaid,proydef,COALESCE(proys,'{}') AS proys
      FROM usuarios ORDER BY apellidos,nombres
    `);
    // también expone 'proyectos' por compatibilidad
    res.json(rows.map(r=>({ ...r, proyectos: r.proys })));
  }catch(e){ console.error(e); res.status(500).json([]); }
});

app.put('/api/usuarios', async (req,res)=>{
  try{
    const list = Array.isArray(req.body) ? req.body : [];
    for (const u of list){
      const proys = Array.isArray(u.proyectos) ? u.proyectos
                   : Array.isArray(u.proys) ? u.proys : [];
      await q(`
        INSERT INTO usuarios (email,dni,nombres,apellidos,role,activo,empresaid,proydef,proys)
        VALUES (lower($1),$2,$3,$4,$5,$6,$7,$8,$9::text[])
        ON CONFLICT (email) DO UPDATE SET
          dni=$2, nombres=$3, apellidos=$4, role=$5, activo=$6,
          empresaid=$7, proydef=$8, proys=$9::text[]
      `, [u.email, u.dni, norm(u.nombres), norm(u.apellidos), u.rol||'USUARIO', !!u.activo, u.empresaid||null, norm(u.proydef||''), proys]);
      // Asegura counter
      if (u.dni) await q(`INSERT INTO counters (dni,n) VALUES ($1,0) ON CONFLICT (dni) DO NOTHING`, [u.dni]);
    }
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({ok:false}); }
});

app.delete('/api/usuarios', async (req,res)=>{
  try{
    const dnis = Array.isArray(req.body?.dnis) ? req.body.dnis : [];
    if (!dnis.length) return res.json({ok:true});
    await q(`DELETE FROM usuarios WHERE dni = ANY($1::text[])`, [dnis]);
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({ok:false}); }
});

// Alta/edición desde modal (compat)
app.put('/api/usuarios/modal', async (req,res)=>{
  try{
    const body = req.body||{};
    const r = body.record||{};
    const proys = Array.isArray(r.proyectos) ? r.proyectos
                 : Array.isArray(r.proys) ? r.proys : [];
    if (body.edit && body.from) {
      // edición por DNI original
      await q(`
        UPDATE usuarios SET
          dni=$1, nombres=$2, apellidos=$3, role=$4, activo=$5,
          empresaid=$6, proydef=$7, proys=$8::text[], email=lower($9)
        WHERE dni=$10
      `,[r.dni, norm(r.nombres), norm(r.apellidos), r.rol||'USUARIO', !!r.activo, r.empresaid||null, norm(r.proydef||''), proys, r.email, body.from]);
    } else {
      await q(`
        INSERT INTO usuarios (email,dni,nombres,apellidos,role,activo,empresaid,proydef,proys)
        VALUES (lower($1),$2,$3,$4,$5,$6,$7,$8,$9::text[])
        ON CONFLICT (email) DO UPDATE SET
          dni=$2, nombres=$3, apellidos=$4, role=$5, activo=$6,
          empresaid=$7, proydef=$8, proys=$9::text[]
      `,[r.email, r.dni, norm(r.nombres), norm(r.apellidos), r.rol||'USUARIO', !!r.activo, r.empresaid||null, norm(r.proydef||''), proys]);
    }
    if (r.dni) await q(`INSERT INTO counters (dni,n) VALUES ($1,0) ON CONFLICT (dni) DO NOTHING`, [r.dni]);
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({ok:false}); }
});

// Siguiente correlativo por DNI
app.get('/api/counters/next', async (req,res)=>{
  try{
    const dni = String(req.query.dni||'');
    if(!dni) return res.status(400).json({next:'00000'});
    const r = await q(`
      INSERT INTO counters (dni,n) VALUES ($1,0)
      ON CONFLICT (dni) DO UPDATE SET n=counters.n+1
      RETURNING n
    `,[dni]);
    res.json({ next: pad(r.rows[0].n) });
  }catch(e){ console.error(e); res.status(500).json({next:'00000'}); }
});

// Crear planilla (inserta items en historial, calcula total y devuelve empresa)
app.post('/api/planillas', async (req,res)=>{
  try{
    const { dni, email, fecha, items=[] } = req.body||{};
    if(!dni || !email || !fecha || !Array.isArray(items) || !items.length){
      return res.status(400).json({ ok:false, msg:'payload invalido' });
    }

    // Usuario + empresa
    const u = (await q(`SELECT * FROM v_usuarios_login WHERE email ILIKE $1 LIMIT 1`, [String(email).toLowerCase()])).rows[0];
    if(!u) return res.status(400).json({ ok:false, msg:'usuario no existe' });

    // Tope por día (acumulado antes de insertar)
    const acc = (await q(`SELECT COALESCE(SUM(total),0) AS s FROM historial WHERE dni=$1 AND fecha=$2`,[dni, fecha])).rows[0].s;
    const totalItems = Number(items.reduce((a,b)=>a + Number(b.monto||0), 0).toFixed(2));
    if(Number(acc) + totalItems > TOPE){
      return res.status(400).json({ ok:false, msg:`Excede el tope diario de S/${TOPE}. Acumulado: S/${acc}` });
    }

    // Correlativo y serie
    const next = (await q(`
      INSERT INTO counters (dni,n) VALUES ($1,0)
      ON CONFLICT (dni) DO UPDATE SET n=counters.n+1
      RETURNING n
    `,[dni])).rows[0].n;
    const num = pad(next);
    const serie = serieFromName(u.nombres, u.apellidos);

    // Insert de items en historial
    for(const it of items){
      const total = Number((Number(it.monto||0)).toFixed(2));
      await q(`
        INSERT INTO historial (dni,email,fecha,serie,num,trabajador,proyecto,destino,motivo,pc,monto,total,empresaid)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,[
        dni, String(email).toLowerCase(), fecha, serie, num,
        `${u.nombres} ${u.apellidos}`, norm(it.proyecto||u.proydef||''), norm(it.destino||''), norm(it.motivo||''), String(it.pc||''), total, total, u.empresaid||null
      ]);
    }

    // Empresa del usuario
    const emp = (await q(`SELECT id,razon,ruc,direccion,telefono,logo FROM empresas WHERE id=$1`, [u.empresaid||null])).rows[0] || null;

    res.json({ ok:true, serie, num, total: totalItems, empresa: emp });
  }catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// Historial (listar / editar / eliminar)
app.get('/api/historial', async (req,res)=>{
  try{
    // si llega dni => filtra; si no, devuelve todo (front decide)
    const dni = req.query.dni ? String(req.query.dni) : null;
    const { rows } = dni
      ? await q(`SELECT * FROM historial WHERE dni=$1 ORDER BY id DESC`, [dni])
      : await q(`SELECT * FROM historial ORDER BY id DESC`);
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json([]); }
});

app.get('/api/historial/acumulado', async (req,res)=>{
  try{
    const dni = String(req.query.dni||'');
    const fecha = String(req.query.fecha||'');
    if(!dni || !fecha) return res.json({ acumulado: 0 });
    const r = await q(`SELECT COALESCE(SUM(total),0) AS s FROM historial WHERE dni=$1 AND fecha=$2`, [dni, fecha]);
    res.json({ acumulado: Number(r.rows[0].s||0) });
  }catch(e){ console.error(e); res.status(500).json({ acumulado: 0 }); }
});

app.put('/api/historial', async (req,res)=>{
  try{
    const changes = Array.isArray(req.body) ? req.body : [];
    for(const c of changes){
      await q(`
        UPDATE historial SET
          serie=$2, num=$3, fecha=$4, trabajador=$5, proyecto=$6, destino=$7,
          motivo=$8, pc=$9, monto=$10, total=$11
        WHERE id=$1
      `,[c.id, c.serie, c.num, c.fecha, c.trabajador, c.proyecto, c.destino, c.motivo, c.pc, Number(c.monto||0), Number(c.total||0)]);
    }
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({ok:false}); }
});

app.delete('/api/historial', async (req,res)=>{
  try{
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if(!ids.length) return res.json({ok:true});
    await q(`DELETE FROM historial WHERE id = ANY($1::int[])`, [ids]);
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({ok:false}); }
});

// PIN admin
app.post('/api/admin/pin', async (req,res)=>{
  try{
    const pin = String(req.body?.pin||'');
    res.json({ ok: pin === ADMIN_PIN });
  }catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// Static (opcional si sirves /public en el mismo servicio)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req,res)=>res.type('text').send('OK'));

// ---- Start ----
bootstrap()
  .then(()=> app.listen(PORT, ()=> console.log(`API lista en :${PORT}`)))
  .catch(err => { console.error('Bootstrap error', err); process.exit(1); });

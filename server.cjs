/**
 * server.cjs (v9 – compat + parser de montos + filtro de filas)
 * - Correlativo por usuario (dni) con transacción
 * - Parser robusto de montos (evita NaN en NUMERIC)
 * - Solo inserta filas con monto > 0
 * - Endpoints compatibles con tu front actual
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
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

// -------------------- helpers --------------------
const q = (sql, p=[]) => pool.query(sql, p);
const pad = (n,w=5)=> String(n).padStart(w,'0');
const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
const serieFromName = (n='',a='') => norm(n).slice(0,2)+norm(a).slice(0,2)+'001';
const normalizeFecha = (f)=>{
  const s = String(f||'').trim();
  if(/^\d{2}\/\d{2}\/\d{4}$/.test(s)){ const [dd,mm,yy]=s.split('/'); return `${yy}-${mm}-${dd}`; }
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
};
const errMsg = (e, fb='Error inesperado')=> e?.msg || e?.detail || e?.hint || (e?.code?`${fb} (PG:${e.code})`:fb);

/** Limpia entradas tipo "S/ 45,00", "45.0", "", null → número con 2 decimales */
function toMoney(v){
  if(v === null || v === undefined) return 0;
  let s = String(v).trim();
  // reemplaza coma por punto y quita símbolos y espacios
  s = s.replace(/,/g,'.').replace(/[^0-9.\-]/g,'');
  // Si hay más de un punto, conserva el último (casos raros)
  const parts = s.split('.');
  if(parts.length > 2){
    const last = parts.pop();
    s = parts.join('') + '.' + last;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

// -------------------- bootstrap --------------------
async function bootstrap(){
  await q(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      razon TEXT NOT NULL,
      ruc TEXT, direccion TEXT, telefono TEXT, logo TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS usuarios (
      email TEXT PRIMARY KEY,
      dni TEXT UNIQUE,
      nombres TEXT NOT NULL,
      apellidos TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE usuarios
      ADD COLUMN IF NOT EXISTS role        TEXT,
      ADD COLUMN IF NOT EXISTS rol         TEXT,
      ADD COLUMN IF NOT EXISTS activo      TEXT,
      ADD COLUMN IF NOT EXISTS empresaid   TEXT REFERENCES empresas(id),
      ADD COLUMN IF NOT EXISTS proydef     TEXT,
      ADD COLUMN IF NOT EXISTS proys       TEXT[] DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS correlativo INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS counters (dni TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);

    CREATE TABLE IF NOT EXISTS historial (
      id SERIAL PRIMARY KEY,
      dni TEXT, email TEXT, fecha TEXT, serie TEXT, num TEXT,
      trabajador TEXT, proyecto TEXT, destino TEXT, motivo TEXT, pc TEXT,
      monto NUMERIC(12,2) DEFAULT 0, total NUMERIC(12,2) DEFAULT 0,
      empresaid TEXT, created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_historial_dni_fecha ON historial(dni,fecha);
    CREATE INDEX IF NOT EXISTS idx_historial_planilla ON historial(dni,serie,num);

    DROP VIEW IF EXISTS v_usuarios_login;
    CREATE VIEW v_usuarios_login AS
    SELECT email, dni, nombres, apellidos,
           CASE WHEN (COALESCE(activo::text,'') IN ('1','t','true','TRUE','on','yes')) THEN TRUE ELSE FALSE END AS activo,
           CASE WHEN role IS NOT NULL AND role<>'' THEN role
                WHEN rol  IS NOT NULL AND rol <>'' THEN rol ELSE 'USUARIO' END AS rol,
           empresaid, proydef, COALESCE(proys,'{}') AS proys
    FROM usuarios;
  `);

  const seeded = await q(`SELECT 1 FROM usuarios LIMIT 1`);
  if(!seeded.rows.length){
    await q(`
      INSERT INTO empresas (id,razon,ruc,direccion,telefono) VALUES
      ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331'),
      ('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO usuarios (email,dni,nombres,apellidos,role,rol,empresaid,proydef,proys,activo) VALUES
      ('admin@empresa.com','44895702','YRVING','LEON','ADMIN_PADOVA','ADMIN_PADOVA','INV_PADOVA','ADMIN PADOVA','{}','1'),
      ('usuario@empresa.com','44081950','JOEL','GARGATE','USUARIO','USUARIO','CONS_PADOVA','SANTA BEATRIZ','{"SANTA BEATRIZ"}','1')
      ON CONFLICT (email) DO NOTHING;
    `);
  }
}

// -------------------- rutas públicas --------------------
app.get('/api/health', (_req,res)=> res.json({ok:true, now:new Date().toISOString()}));

app.get('/api/login', async (req,res)=>{
  try{
    const email = String(req.query.email||'').toLowerCase();
    if(!email) return res.status(400).json(null);
    const r = await q(`SELECT * FROM v_usuarios_login WHERE email ILIKE $1 LIMIT 1`, [email]);
    const u = r.rows[0]; if(!u) return res.json(null);
    res.json({ email:u.email, nombres:u.nombres, apellidos:u.apellidos, dni:u.dni,
               rol:u.rol, activo:!!u.activo, empresaid:u.empresaid, proydef:u.proydef, proys:u.proys||[] });
  }catch(e){ console.error(e); res.status(500).json(null); }
});

app.get('/api/empresas', async (_req,res)=>{
  try{
    const {rows}=await q(`SELECT id,razon,ruc,direccion,telefono,logo FROM empresas ORDER BY razon`);
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json([]); }
});

app.get('/api/usuarios', async (_req,res)=>{
  try{
    const {rows}=await q(`
      SELECT email,dni,nombres,apellidos,
             CASE WHEN role IS NOT NULL AND role<>'' THEN role
                  WHEN rol  IS NOT NULL AND rol <>'' THEN rol ELSE 'USUARIO' END AS rol,
             CASE WHEN (COALESCE(activo::text,'') IN ('1','t','true','TRUE','on','yes')) THEN TRUE ELSE FALSE END AS activo,
             empresaid, proydef, COALESCE(proys,'{}') AS proys
      FROM usuarios ORDER BY apellidos,nombres`);
    res.json(rows.map(r=>({...r, proyectos:r.proys})));
  }catch(e){ console.error(e); res.status(500).json([]); }
});

// -------------------- counters: peek por dni (no incrementa) --------------------
app.get('/api/counters/next', async (req,res)=>{
  try{
    const dni = String(req.query.dni||'');
    if(!dni) return res.status(400).json({ next:'00001' });
    const r = await q(`SELECT n FROM counters WHERE dni=$1`, [dni]);
    res.json({ next: pad(r.rows.length ? r.rows[0].n + 1 : 1) });
  }catch(e){ console.error(e); res.status(500).json({ next:'00000' }); }
});

// -------------------- planillas (transacción + correlativo por usuario) --------------------
app.post('/api/planillas', async (req,res)=>{
  const client = await pool.connect();
  try{
    const { dni, email, fecha, items=[] } = req.body||{};
    if(!dni || !email || !fecha || !Array.isArray(items)){
      client.release(); return res.status(400).json({ ok:false, msg:'Payload inválido' });
    }

    // Normaliza y FILTRA filas (solo monto > 0)
    const normalized = (items||[]).map(it => ({
      proyecto: norm(it.proyecto || ''),
      destino : norm(it.destino  || ''),
      motivo  : norm(it.motivo   || ''),
      pc      : String(it.pc || ''),
      monto   : toMoney(it.monto)
    })).filter(it => it.monto > 0);

    if(!normalized.length){
      client.release(); return res.status(400).json({ ok:false, msg:'No hay filas con monto > 0' });
    }

    const fechaISO = normalizeFecha(fecha);
    await client.query('BEGIN');

    const u = (await client.query(`SELECT * FROM v_usuarios_login WHERE email ILIKE $1 LIMIT 1`, [String(email).toLowerCase()])).rows[0];
    if(!u){ await client.query('ROLLBACK'); client.release(); return res.status(400).json({ ok:false, msg:'Usuario no existe' }); }

    // Tope por día
    const acc = (await client.query(`SELECT COALESCE(SUM(total),0) AS s FROM historial WHERE dni=$1 AND fecha=$2`, [dni, fechaISO])).rows[0].s;
    const totalItems = Number(normalized.reduce((a,b)=>a + b.monto, 0).toFixed(2));
    if(Number(acc) + totalItems > TOPE){
      await client.query('ROLLBACK'); client.release();
      return res.status(400).json({ ok:false, msg:`Excede el tope diario de S/${TOPE}. Acumulado: S/${acc}` });
    }

    // incremento real del correlativo (usuario)
    const bumped = (await client.query(`
      INSERT INTO counters (dni,n) VALUES ($1,1)
      ON CONFLICT (dni) DO UPDATE SET n=counters.n+1
      RETURNING n
    `,[dni])).rows[0].n;

    const num = pad(bumped);
    const serie = serieFromName(u.nombres, u.apellidos);
    const trabajador = `${u.nombres} ${u.apellidos}`;

    const detalle=[];
    for(const it of normalized){
      await client.query(`
        INSERT INTO historial (dni,email,fecha,serie,num,trabajador,proyecto,destino,motivo,pc,monto,total,empresaid)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,[ dni, String(email).toLowerCase(), fechaISO, serie, num,
          trabajador, it.proyecto || u.proydef || '', it.destino, it.motivo, it.pc,
          it.monto, it.monto, u.empresaid||null ]);
      detalle.push({ proyecto: it.proyecto || u.proydef || '', destino: it.destino, motivo: it.motivo, pc: it.pc, monto: it.monto, total: it.monto });
    }

    const emp = (await client.query(`SELECT id,razon,ruc,direccion,telefono,logo FROM empresas WHERE id=$1`, [u.empresaid||null])).rows[0] || null;

    await client.query('COMMIT'); client.release();
    res.json({ ok:true, serie, num, fecha:fechaISO, total: totalItems, empresa: emp, trabajador, detalle });
  }catch(e){
    try{ await client.query('ROLLBACK'); }catch(_){}
    try{ client.release(); }catch(_){}
    console.error('POST /api/planillas error:', e);
    res.status(400).json({ ok:false, msg: errMsg(e, 'Error al guardar la planilla') });
  }
});

// -------------------- historial (compat; respeta dni cuando se envía) --------------------
app.get('/api/historial', async (req,res)=>{
  try{
    const dni = req.query.dni ? String(req.query.dni) : null;
    if(dni){
      const {rows}=await q(`SELECT * FROM historial WHERE dni=$1 ORDER BY id DESC`, [dni]);
      return res.json(rows);
    }
    res.json([]);
  }catch(e){ console.error(e); res.status(500).json([]); }
});

app.get('/api/historial/planilla', async (req,res)=>{
  try{
    const dni=String(req.query.dni||''); const serie=String(req.query.serie||''); const num=String(req.query.num||'');
    if(!dni || !serie || !num) return res.status(400).json([]);
    const {rows}=await q(`SELECT * FROM historial WHERE dni=$1 AND serie=$2 AND num=$3 ORDER BY id`, [dni,serie,num]);
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json([]); }
});

app.get('/api/historial/by-date', async (req,res)=>{
  try{
    const dni = String(req.query.dni||''); const fecha = normalizeFecha(String(req.query.fecha||''));
    if(!dni || !fecha) return res.status(400).json([]);
    const {rows}=await q(`SELECT * FROM historial WHERE dni=$1 AND fecha=$2 ORDER BY id`, [dni,fecha]);
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json([]); }
});

app.put('/api/historial', async (req,res)=>{
  try{
    const changes = Array.isArray(req.body) ? req.body : [];
    for(const c of changes){
      await q(`UPDATE historial SET
               serie=$2,num=$3,fecha=$4,trabajador=$5,proyecto=$6,destino=$7,motivo=$8,pc=$9,monto=$10,total=$11
               WHERE id=$1`,
               [c.id,c.serie,c.num,normalizeFecha(c.fecha),c.trabajador,c.proyecto,c.destino,c.motivo,c.pc,Number(toMoney(c.monto)),Number(toMoney(c.total))]);
    }
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({ok:false,msg:errMsg(e,'Error editando historial')}); }
});

app.delete('/api/historial', async (req,res)=>{
  try{
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if(!ids.length) return res.json({ok:true});
    await q(`DELETE FROM historial WHERE id = ANY($1::int[])`, [ids]);
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({ok:false,msg:errMsg(e,'Error eliminando del historial')}); }
});

// -------------------- admin pin (opcional) --------------------
app.post('/api/admin/pin', async (req,res)=>{
  try{ const pin = String(req.body?.pin||''); res.json({ ok: pin===ADMIN_PIN }); }
  catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// -------------------- static & start --------------------
app.use(express.static(path.join(__dirname,'public')));
app.get('/', (_req,res)=> res.type('text').send('OK'));

bootstrap()
  .then(()=> app.listen(PORT, ()=> console.log(`API lista en :${PORT}`)))
  .catch(err=>{ console.error('Bootstrap error', err); process.exit(1); });

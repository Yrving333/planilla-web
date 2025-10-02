import express from "express";
import cors from "cors";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ========= ENV ========= */
const {
  DATABASE_URL,
  ADMIN_PIN = "1234",
  TOPE = "45",
  CORS_ORIGIN = ""
} = process.env;

if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL");
  process.exit(1);
}

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const q = (text, params = []) => pool.query(text, params);

/* ========= Bootstrap ========= */
async function bootstrap() {
  // Tablas
  await q(`
  CREATE TABLE IF NOT EXISTS empresas(
    id TEXT PRIMARY KEY,
    razon TEXT NOT NULL,
    ruc TEXT NOT NULL,
    direccion TEXT DEFAULT '',
    telefono TEXT DEFAULT '',
    logo TEXT
  );
  CREATE TABLE IF NOT EXISTS pcs(
    codigo TEXT NOT NULL,
    empresaid TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    PRIMARY KEY (codigo, empresaid)
  );
  /* activo lo guardamos como TEXT para tolerar '1'/'0'/'t'/'f' */
  CREATE TABLE IF NOT EXISTS usuarios(
    email TEXT PRIMARY KEY,
    dni TEXT NOT NULL,
    nombres TEXT NOT NULL,
    apellidos TEXT NOT NULL,
    rol TEXT NOT NULL,
    activo TEXT DEFAULT '1',
    empresaid TEXT NOT NULL REFERENCES empresas(id),
    proydef TEXT DEFAULT '',
    proys TEXT[] DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS counters(
    dni TEXT PRIMARY KEY,
    last_num INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS planillas(
    id BIGSERIAL PRIMARY KEY,
    serie TEXT NOT NULL,
    num INTEGER NOT NULL,
    dni TEXT NOT NULL,
    email TEXT NOT NULL,
    empresaid TEXT NOT NULL,
    fecha DATE NOT NULL,
    total NUMERIC(12,2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS planillas_items(
    id BIGSERIAL PRIMARY KEY,
    planilla_id BIGINT NOT NULL REFERENCES planillas(id) ON DELETE CASCADE,
    destino TEXT, motivo TEXT, proyecto TEXT, pc TEXT,
    monto NUMERIC(12,2) NOT NULL
  );
  `);

  // Vista de login (convierte activo a boolean)
  await q(`
  CREATE OR REPLACE VIEW v_usuarios_login AS
  SELECT email, dni, nombres, apellidos, rol,
         CASE WHEN COALESCE(activo,'')::TEXT IN ('1','t','true','TRUE') THEN TRUE ELSE FALSE END AS activo,
         empresaid, proydef, COALESCE(proys,'{}'::TEXT[]) AS proys
  FROM usuarios;
  `);

  // Semillas mínimas
  await q(`INSERT INTO empresas(id,razon,ruc,direccion,telefono)
           VALUES
           ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','Av. Primavera 123','01-555555'),
           ('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','La Molina Vieja 139','01-444444')
           ON CONFLICT (id) DO NOTHING;`);

  await q(`INSERT INTO pcs(codigo,empresaid) VALUES
           ('94303','INV_PADOVA'),
           ('94601','INV_PADOVA'),
           ('94303','CONS_PADOVA')
           ON CONFLICT DO NOTHING;`);

  await q(`
    INSERT INTO usuarios(email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys)
    VALUES
    ('admin@empresa.com','44895702','YRVING','LEON','ADMIN_PADOVA','1','INV_PADOVA','ADMIN PADOVA', ARRAY['ADMIN PADOVA','LITORAL 900']),
    ('usuario@empresa.com','44801950','JOEL','GARGATE','USUARIO','1','CONS_PADOVA','SANTA BEATRIZ', ARRAY['SANTA BEATRIZ'])
    ON CONFLICT (email) DO NOTHING;
  `);

  console.log("Bootstrap OK");
}

/* ========= App ========= */
const app = express();
app.use(express.json({ limit: "5mb" }));
if (CORS_ORIGIN) {
  app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
} else {
  app.use(cors());
}

/* ======= estático ======= */
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

/* ========= helpers ========= */
const asBool = (v) => String(v ?? "").match(/^(1|t|true)$/i) != null;
const getUser = async (email) => {
  const r = await q(`SELECT * FROM v_usuarios_login WHERE lower(email)=lower($1)`, [email]);
  return r.rows[0] || null;
};
const getEmpresa = async (id) => {
  const r = await q(`SELECT * FROM empresas WHERE id=$1`, [id]);
  return r.rows[0] || null;
};
const initials = (nombres, apellidos) => {
  const n = (nombres||'').trim().toUpperCase();
  const a = (apellidos||'').trim().toUpperCase();
  return (n[0]||'X') + (a[0]||'X');
};

/* ========= API ========= */

// health/version
app.get("/api/version", (_req, res) => {
  res.json({ ok: true, tope: Number(TOPE) || 45 });
});

// empresas (simple/all)
app.get("/api/empresas", async (req, res) => {
  try {
    const simple = String(req.query.simple||"") === "1";
    const r = await q(`SELECT ${simple?'id,razon,ruc,direccion,telefono':'*'} FROM empresas ORDER BY id`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// pcs por empresa
app.get("/api/pcs", async (req, res) => {
  try{
    const emp = String(req.query.emp||"");
    const r = await q(`SELECT codigo FROM pcs WHERE empresaid=$1 ORDER BY codigo`, [emp]);
    res.json(r.rows.map(x=>x.codigo));
  }catch(e){ res.status(500).json({ error:e.message }); }
});

// usuarios (admin usa esto) y front lo usa para selector
app.get("/api/usuarios", async (_req, res) => {
  try {
    const r = await q(`SELECT * FROM v_usuarios_login ORDER BY apellidos,nombres`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// login por email
app.get("/api/login", async (req, res) => {
  try {
    const email = String(req.query.email||"");
    const u = await getUser(email);
    if (!u) return res.status(404).json({ error: "Usuario no existe" });
    if (!asBool(u.activo)) return res.status(400).json({ error: "Usuario inactivo" });
    res.json(u);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// acumulado del día (para tope)
app.get("/api/acumulado", async (req, res) => {
  try {
    const { dni="", fecha="" } = req.query;
    const r = await q(
      `SELECT COALESCE(SUM(pi.monto),0) AS acumulado
       FROM planillas p
       JOIN planillas_items pi ON pi.planilla_id=p.id
       WHERE p.dni=$1 AND p.fecha=$2`, [dni, fecha]
    );
    res.json({ acumulado: Number(r.rows[0]?.acumulado||0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// historial (propio o admin todos)
app.get("/api/historial", async (req,res)=>{
  try{
    const email = String(req.query.email||"");
    const all = String(req.query.all||"") === "1";
    let sql = `SELECT serie,num,fecha,empresaid,total FROM planillas`;
    let params=[];
    if(!all){ sql += ` WHERE lower(email)=lower($1)`; params=[email]; }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await q(sql, params);
    res.json(r.rows);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// crear planilla (valida tope, serie/correlativo)
app.post("/api/planillas", async (req, res) => {
  try{
    const { dni, email, fecha, items=[] } = req.body||{};
    if(!dni || !email || !fecha) return res.status(400).json({ error:"Datos incompletos" });
    if(!Array.isArray(items) || items.length===0) return res.status(400).json({ error:"Sin ítems" });

    const u = await getUser(email);
    if(!u) return res.status(404).json({ error:"Usuario no existe" });
    if(!asBool(u.activo)) return res.status(400).json({ error:"Usuario inactivo" });

    // tope
    const rAc = await q(
      `SELECT COALESCE(SUM(pi.monto),0) AS acum
       FROM planillas p JOIN planillas_items pi ON pi.planilla_id=p.id
       WHERE p.dni=$1 AND p.fecha=$2`, [dni, fecha]
    );
    const acum = Number(rAc.rows[0]?.acum||0);
    const total = Number(items.reduce((s,x)=> s + Number(x?.monto||0), 0).toFixed(2));
    const topeNum = Number(TOPE)||45;
    if(acum + total > topeNum + 1e-6){
      return res.status(400).json({ error:`Supera tope. Acumulado: ${acum.toFixed(2)} + Actual: ${total.toFixed(2)} > ${topeNum.toFixed(2)}` });
    }

    // correlativo por dni
    await q(`INSERT INTO counters(dni,last_num) VALUES($1,0) ON CONFLICT (dni) DO NOTHING`, [dni]);
    const upd = await q(`UPDATE counters SET last_num=last_num+1 WHERE dni=$1 RETURNING last_num`, [dni]);
    const num = Number(upd.rows[0].last_num||1);
    const serie = initials(u.nombres, u.apellidos);

    // empresa del usuario
    const emp = await getEmpresa(u.empresaid);

    // header
    const ins = await q(
      `INSERT INTO planillas(serie,num,dni,email,empresaid,fecha,total)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [serie, num, dni, email, u.empresaid, fecha, total]
    );
    const pid = ins.rows[0].id;

    // items
    const values = [];
    const params = [];
    items.forEach((it, i)=>{
      params.push(pid, (it.destino||'').toUpperCase(), (it.motivo||'').toUpperCase(),
                  (it.proyecto||'').toUpperCase(), (it.pc||''), Number(it.monto||0));
      values.push(`($${params.length-5},$${params.length-4},$${params.length-3},$${params.length-2},$${params.length-1})`);
    });
    await q(
      `INSERT INTO planillas_items(planilla_id,destino,motivo,proyecto,pc,monto)
       VALUES ${values.map(v=>v.replace(')',' ,$'+(params.length+1)+')')).join(',')}`.replace(/ ,\$/, ', $'),
      // truco: re-usa el patrón generando índices correctos
      (()=>{ // construimos un array con bloques de 5 + monto
        const out=[]; let i=0;
        for(const it of items){
          out.push(pid,(it.destino||'').toUpperCase(),(it.motivo||'').toUpperCase(),(it.proyecto||'').toUpperCase(),(it.pc||''),Number(it.monto||0));
        }
        return out;
      })()
    ).catch(async()=>{ // fallback sencillo si el generador anterior te resulta raro
      for(const it of items){
        await q(`INSERT INTO planillas_items(planilla_id,destino,motivo,proyecto,pc,monto) VALUES($1,$2,$3,$4,$5,$6)`,
          [pid,(it.destino||'').toUpperCase(),(it.motivo||'').toUpperCase(),(it.proyecto||'').toUpperCase(),(it.pc||''),Number(it.monto||0)]
        );
      }
    });

    res.json({ ok:true, serie, num, total, fecha, empresa: emp, u });
  }catch(e){
    console.error("Guardar planilla - error:", e);
    res.status(500).json({ error:e.message });
  }
});

/* ========= Admin ========= */
const requirePin = (req,res,next)=>{
  const pin = req.headers["x-admin-pin"] || req.body?.pin || req.query?.pin;
  if(String(pin) !== String(ADMIN_PIN)) return res.status(401).json({ error:"PIN inválido" });
  next();
};
app.post("/api/admin/pin", requirePin, (_req,res)=> res.json({ ok:true }));

app.put("/api/admin/empresas", requirePin, async (req,res)=>{
  try{
    const { empresas=[] } = req.body||{};
    for(const e of empresas){
      await q(`INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
               VALUES($1,$2,$3,$4,$5,$6)
               ON CONFLICT (id) DO UPDATE SET
                 razon=EXCLUDED.razon, ruc=EXCLUDED.ruc, direccion=EXCLUDED.direccion,
                 telefono=EXCLUDED.telefono, logo=EXCLUDED.logo`,
               [e.id, e.razon, e.ruc, e.direccion||'', e.telefono||'', e.logo||null]);
    }
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.put("/api/admin/usuarios", requirePin, async (req,res)=>{
  try{
    const { usuarios=[] } = req.body||{};
    for(const u of usuarios){
      const proys = Array.isArray(u.proys) ? u.proys : String(u.proys||'').split(',').map(x=>x.trim()).filter(Boolean);
      await q(`INSERT INTO usuarios(email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (email) DO UPDATE SET
                 dni=EXCLUDED.dni, nombres=EXCLUDED.nombres, apellidos=EXCLUDED.apellidos,
                 rol=EXCLUDED.rol, activo=EXCLUDED.activo, empresaid=EXCLUDED.empresaid,
                 proydef=EXCLUDED.proydef, proys=EXCLUDED.proys`,
          [u.email, u.dni, u.nombres, u.apellidos, u.rol, String(u.activo||'1'), u.empresaid, u.proydef||'', proys]);
    }
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

/* ========= start ========= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async ()=>{
  try{
    await bootstrap();
    console.log("Server on http://localhost:"+PORT);
  }catch(e){
    console.error("Bootstrap error", e);
    process.exit(1);
  }
});

// server.cjs
'use strict';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const {
  DATABASE_URL,
  PORT = 1000,
  NODE_ENV = 'production',
  CORS_ORIGIN = '*',
  TOPE = '45',
  ADMIN_PIN = '1234',
} = process.env;

if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    credentials: true,
  })
);

// ---------- util ----------
const money = (n) => Number((+n || 0).toFixed(2));
const pad5 = (n) => String(n).padStart(5, '0');
const initialsSerie = (nombres = '', apellidos = '') => {
  const n = (nombres || '').trim().split(/\s+/)[0] || '';
  const a = (apellidos || '').trim().split(/\s+/)[0] || '';
  const s = (n[0] || 'X') + (a[0] || 'X');
  return s.toUpperCase();
};

// ---------- bootstrap SQL ----------
const bootstrapSQL = `
CREATE TABLE IF NOT EXISTS empresas(
  id TEXT PRIMARY KEY,
  razon TEXT NOT NULL,
  ruc TEXT,
  direccion TEXT,
  telefono TEXT,
  logo TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuarios(
  email TEXT PRIMARY KEY,
  dni TEXT NOT NULL,
  nombres TEXT NOT NULL,
  apellidos TEXT NOT NULL,
  rol TEXT,
  role TEXT,
  activo BOOLEAN DEFAULT TRUE,
  empresaid TEXT REFERENCES empresas(id),
  proydef TEXT,
  proys TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT now()
);

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rol TEXT;
UPDATE usuarios SET rol = COALESCE(rol, role);

CREATE TABLE IF NOT EXISTS counters(
  dni TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pcs(
  code TEXT PRIMARY KEY,
  nombre TEXT
);

INSERT INTO pcs(code,nombre) VALUES
('94303','94303'),('94601','94601')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS historial(
  id BIGSERIAL PRIMARY KEY,
  dni TEXT NOT NULL,
  email TEXT NOT NULL,
  fecha DATE NOT NULL,
  serie TEXT NOT NULL,
  num INTEGER NOT NULL,
  numero TEXT NOT NULL,
  empresaid TEXT,
  empresa JSONB,
  usuario JSONB,
  items JSONB NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

-- Vista de login robusta (soporta activo=1/'t'/true)
CREATE OR REPLACE VIEW v_usuarios_login AS
SELECT
  u.email,
  u.dni,
  u.nombres,
  u.apellidos,
  COALESCE(NULLIF(u.rol,''), NULLIF(u.role,''), 'USUARIO')::text AS rol,
  (CASE
     WHEN u.activo IS TRUE THEN TRUE
     WHEN u.activo IS FALSE THEN FALSE
     WHEN u.activo::text ILIKE 't' OR u.activo::text='1' OR u.activo::text ILIKE 'true' THEN TRUE
     ELSE FALSE
   END) AS activo,
  u.empresaid,
  COALESCE(u.proydef,'') AS proydef,
  COALESCE(u.proys,'{}') AS proys
FROM usuarios u;

-- Usuario y empresa demo si hiciera falta
INSERT INTO empresas(id,razon,ruc,direccion,telefono)
VALUES ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331')
ON CONFLICT (id) DO NOTHING;

INSERT INTO usuarios(email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys)
VALUES ('admin@empresa.com','44895702','YRVING','LEON','ADMIN_PADOVA',TRUE,'INV_PADOVA','ADMIN PADOVA',ARRAY['ADMIN PADOVA','LITORAL 900'])
ON CONFLICT (email) DO NOTHING;
`;

async function bootstrap() {
  await pool.query(bootstrapSQL);
  console.log('DB bootstrap OK');
}

// ---------- helpers DB ----------
async function one(q, p) {
  const { rows } = await pool.query(q, p);
  return rows[0] || null;
}
async function many(q, p) {
  const { rows } = await pool.query(q, p);
  return rows;
}

// ---------- API ----------
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Empresas
app.get('/api/empresas', async (req, res) => {
  try {
    const rows = await many(
      `SELECT id,razon,ruc,direccion,telefono,logo FROM empresas ORDER BY razon`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Usuarios (para combos y UI)
app.get('/api/usuarios', async (req, res) => {
  try {
    const rows = await many(
      `SELECT email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys FROM v_usuarios_login ORDER BY apellidos,nombres`
    );
    // alias "proyectos" para el front
    rows.forEach(r => (r.proyectos = r.proys));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login por email
app.get('/api/login', async (req, res) => {
  try {
    const { email = '' } = req.query;
    const row = await one(
      `SELECT email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys
       FROM v_usuarios_login WHERE lower(email)=lower($1)`,
      [String(email).trim()]
    );
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!row.activo)
      return res.status(403).json({ error: 'Usuario inactivo' });

    const emp = row.empresaid
      ? await one(`SELECT * FROM empresas WHERE id=$1`, [row.empresaid])
      : null;
    row.proyectos = row.proys;
    row.empresa = emp;
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Catálogo de PCs
app.get('/api/pcs', async (_req, res) => {
  try {
    const rows = await many(`SELECT code AS pc, nombre FROM pcs ORDER BY code`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Acumulado día por DNI
app.get('/api/acumulado', async (req, res) => {
  try {
    const { dni = '', fecha } = req.query;
    if (!dni || !fecha) return res.json({ acc: 0 });
    const r = await one(
      `SELECT COALESCE(SUM(total),0) acc
       FROM historial
       WHERE dni=$1 AND fecha=$2`,
      [dni, fecha]
    );
    res.json({ acc: Number(r?.acc || 0) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardar planilla
app.post('/api/planillas', async (req, res) => {
  const client = await pool.connect();
  try {
    const TOPE_VAL = Number(TOPE || 45);
    const { dni, email, fecha, items = [] } = req.body || {};
    if (!dni || !email || !fecha || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // Usuario + empresa
    const u = await one(
      `SELECT * FROM v_usuarios_login WHERE lower(email)=lower($1)`,
      [email]
    );
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!u.activo) return res.status(403).json({ error: 'Usuario inactivo' });

    const emp = u.empresaid
      ? await one(`SELECT id,razon,ruc,direccion,telefono,logo FROM empresas WHERE id=$1`, [u.empresaid])
      : null;

    // totales
    const totalItems = items.reduce((a, it) => a + money(it?.monto), 0);
    const accRow = await one(
      `SELECT COALESCE(SUM(total),0) acc FROM historial WHERE dni=$1 AND fecha=$2`,
      [dni, fecha]
    );
    const acc = Number(accRow?.acc || 0);
    if (acc + totalItems > TOPE_VAL) {
      return res
        .status(400)
        .json({ error: `Se excede el tope diario. Acumulado: S/ ${acc.toFixed(2)}.` });
    }

    await client.query('BEGIN');

    // correlativo por usuario (dni)
    await client.query(
      `INSERT INTO counters(dni,n) VALUES ($1,0)
       ON CONFLICT (dni) DO NOTHING`,
      [dni]
    );
    const upd = await client.query(
      `UPDATE counters SET n = n + 1 WHERE dni=$1 RETURNING n`,
      [dni]
    );
    const num = Number(upd.rows[0].n);
    const serie = initialsSerie(u.nombres, u.apellidos);
    const numero = `${serie}${pad5(num)}`;

    await client.query(
      `INSERT INTO historial(dni,email,fecha,serie,num,numero,empresaid,empresa,usuario,items,total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        dni,
        email,
        fecha,
        serie,
        num,
        numero,
        u.empresaid || null,
        emp ? JSON.stringify(emp) : null,
        JSON.stringify({
          email: u.email,
          dni: u.dni,
          nombres: u.nombres,
          apellidos: u.apellidos,
          rol: u.rol,
        }),
        JSON.stringify(items),
        money(totalItems),
      ]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      fecha,
      total: money(totalItems),
      acc,
      tope: TOPE_VAL,
      serie,
      num: pad5(num),
      numero,
      empresa: emp,
      usuario: {
        email: u.email,
        dni: u.dni,
        nombres: u.nombres,
        apellidos: u.apellidos,
        rol: u.rol,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Historial (mine=1 o admin ve todo)
app.get('/api/historial', async (req, res) => {
  try {
    const { email = '', rol = 'USUARIO' } = req.query;
    let rows;
    if (String(rol).toUpperCase() === 'ADMIN_PADOVA') {
      rows = await many(
        `SELECT id,numero,fecha,email,dni,empresa->>'razon' AS razon,total,created_at
         FROM historial ORDER BY id DESC LIMIT 500`
      );
    } else {
      rows = await many(
        `SELECT id,numero,fecha,email,dni,empresa->>'razon' AS razon,total,created_at
         FROM historial WHERE lower(email)=lower($1) ORDER BY id DESC LIMIT 300`,
        [email]
      );
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Admin PIN ----
app.post('/api/admin/pin', (req, res) => {
  const { pin = '' } = req.body || {};
  if (String(pin) === String(ADMIN_PIN)) return res.json({ ok: true });
  return res.status(401).json({ error: 'PIN inválido' });
});

// ---- Admin: empresas ----
app.get('/api/admin/empresas', async (_req, res) => {
  try {
    const rows = await many(`SELECT * FROM empresas ORDER BY razon`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/empresas', async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    for (const e of list) {
      await pool.query(
        `INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id)
         DO UPDATE SET razon=$2,ruc=$3,direccion=$4,telefono=$5,logo=$6`,
        [e.id, e.razon, e.ruc, e.direccion, e.telefono, e.logo || null]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Admin: usuarios ----
app.get('/api/admin/usuarios', async (_req, res) => {
  try {
    const rows = await many(
      `SELECT email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys
       FROM usuarios ORDER BY apellidos,nombres`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/usuarios', async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    for (const u of list) {
      await pool.query(
        `INSERT INTO usuarios(email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (email)
         DO UPDATE SET dni=$2,nombres=$3,apellidos=$4,rol=$5,activo=$6,empresaid=$7,proydef=$8,proys=$9`,
        [
          u.email, u.dni, u.nombres, u.apellidos,
          u.rol || 'USUARIO',
          !!u.activo,
          u.empresaid || null,
          u.proydef || null,
          Array.isArray(u.proys) ? u.proys : [],
        ]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Static (opcional si sirves el index desde el mismo servicio) ----------
app.use(express.static('.')); // si subes index.html junto al server

// ---------- start ----------
bootstrap()
  .then(() => {
    app.listen(PORT, () => console.log(`API lista en :${PORT}`));
  })
  .catch((e) => {
    console.error('Bootstrap error', e);
    process.exit(1);
  });

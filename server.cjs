/* server.cjs */
'use strict';

/* ========= Dependencias ========= */
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

/* ========= Entorno ========= */
require('dotenv').config();
const PORT = Number(process.env.PORT || 1000);
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const TOPE = Number(process.env.TOPE || 45);

/* ========= DB ========= */
if (!DATABASE_URL) {
  console.error('DATABASE_URL no está definido.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon
});

/* ========= App ========= */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/* CORS */
const corsOpt = {
  credentials: true,
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_ORIGIN.length === 0) return cb(null, true);
    if (CORS_ORIGIN.includes(origin)) return cb(null, true);
    return cb(new Error('CORS bloqueado: ' + origin), false);
  }
};
app.use(cors(corsOpt));

/* ========= Bootstrap de BD ========= */
async function bootstrap() {
  const sql = `
  CREATE TABLE IF NOT EXISTS empresas(
    id        TEXT PRIMARY KEY,
    razon     TEXT NOT NULL,
    ruc       TEXT NOT NULL,
    direccion TEXT DEFAULT '',
    telefono  TEXT DEFAULT '',
    logo      TEXT DEFAULT '',      -- base64 opcional
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS usuarios(
    email     TEXT PRIMARY KEY,
    dni       TEXT NOT NULL,
    nombres   TEXT NOT NULL,
    apellidos TEXT NOT NULL,
    rol       TEXT NOT NULL,        -- 'ADMIN_PADOVA' | 'USUARIO'
    activo    BOOLEAN NOT NULL DEFAULT TRUE,
    empresaid TEXT REFERENCES empresas(id) ON DELETE SET NULL,
    proydef   TEXT DEFAULT '',
    proys     TEXT[] DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS counters(
    dni TEXT PRIMARY KEY,
    n   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS historial(
    id        BIGSERIAL PRIMARY KEY,
    dni       TEXT NOT NULL,
    email     TEXT NOT NULL,
    empresaid TEXT,
    fecha     DATE NOT NULL,
    serie     TEXT NOT NULL,
    num       INTEGER NOT NULL,
    items     JSONB NOT NULL DEFAULT '[]'::jsonb,
    total     NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_hist_dni_fecha ON historial(dni, fecha);
  `;

  await pool.query(sql);

  // Seed mínimo si está vacío
  const { rows: ecount } = await pool.query(`SELECT COUNT(*)::int AS c FROM empresas`);
  if (ecount[0].c === 0) {
    await pool.query(
      `INSERT INTO empresas(id, razon, ruc, direccion, telefono)
       VALUES($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)
      `,
      [
        'INV_PADOVA', 'INVERSIONES PADOVA S.A.C.', '20523824598', 'JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA', '495-1331',
        'CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331'
      ]
    );
  }

  const { rows: ucount } = await pool.query(`SELECT COUNT(*)::int AS c FROM usuarios`);
  if (ucount[0].c === 0) {
    await pool.query(
      `INSERT INTO usuarios(email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys)
       VALUES
       ('admin@empresa.com','44895702','YRVING','LEON','ADMIN_PADOVA',TRUE,'INV_PADOVA','ADMIN PADOVA',ARRAY['ADMIN PADOVA','LITORAL 900']),
       ('usuario@empresa.com','44081950','JOEL','GARGATE','USUARIO',TRUE,'CONS_PADOVA','SANTA BEATRIZ',ARRAY['SANTA BEATRIZ'])
      `
    );
  }
}

/* ========= Helpers ========= */
const pad = (n, w = 5) => String(n).padStart(w, '0');

async function nextCorrelativo(dni) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(`UPDATE counters SET n = n + 1 WHERE dni = $1 RETURNING n`, [dni]);
    let n;
    if (upd.rowCount === 0) {
      const ins = await client.query(`INSERT INTO counters(dni, n) VALUES($1, 1) RETURNING n`, [dni]);
      n = ins.rows[0].n;
    } else {
      n = upd.rows[0].n;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function requireAdmin(req) {
  // Autorización simple por header con PIN (suficiente para este entorno)
  const pin = req.headers['x-admin-pin'] || req.query.pin || req.body?.pin;
  if (String(pin) !== String(ADMIN_PIN)) {
    const err = new Error('No autorizado (PIN inválido).');
    err.status = 401;
    throw err;
  }
}

/* ========= Rutas API ========= */

// Ping
app.get('/api/ping', (_, res) => res.json({ ok: true, tope: TOPE }));

// Empresas
app.get('/api/empresas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, razon, ruc, direccion, telefono, logo FROM empresas ORDER BY id`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// Usuarios
app.get('/api/usuarios', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT email, dni, nombres, apellidos, rol, activo, empresaid, proydef, COALESCE(proys, ARRAY[]::text[]) AS proys
       FROM usuarios
       ORDER BY apellidos, nombres`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// Login por email (sin password – se valida existencia y activo)
app.get('/api/login', async (req, res, next) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ msg: 'email requerido' });
    const { rows } = await pool.query(
      `SELECT email, dni, nombres, apellidos, rol, activo, empresaid, proydef, COALESCE(proys, ARRAY[]::text[]) AS proys
       FROM usuarios WHERE lower(email)=$1`, [email]
    );
    if (!rows.length) return res.status(404).json({ msg: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Acumulado del día por usuario (para validar tope)
app.get('/api/acumulado', async (req, res, next) => {
  try {
    const dni = String(req.query.dni || '').trim();
    const fecha = String(req.query.fecha || '').trim(); // 'YYYY-MM-DD'
    if (!dni || !fecha) return res.status(400).json({ msg: 'dni y fecha son requeridos' });

    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(total),0)::numeric(12,2) AS acc
       FROM historial WHERE dni=$1 AND fecha=$2`, [dni, fecha]
    );
    res.json({ acc: Number(rows[0].acc), tope: TOPE });
  } catch (e) { next(e); }
});

// Guardar planilla y devolver datos para PDF
app.post('/api/planillas', async (req, res, next) => {
  try {
    const { dni, email, fecha, items } = req.body || {};
    if (!dni || !email || !fecha || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ msg: 'dni, email, fecha e items son requeridos' });
    }

    // Usuario
    const ures = await pool.query(
      `SELECT email, dni, nombres, apellidos, rol, activo, empresaid FROM usuarios WHERE lower(email)=lower($1)`,
      [email]
    );
    if (!ures.rowCount) return res.status(404).json({ msg: 'Usuario no existe' });
    const u = ures.rows[0];
    if (u.dni !== dni) return res.status(400).json({ msg: 'dni no coincide con el usuario' });
    if (u.activo !== true) return res.status(403).json({ msg: 'Usuario inactivo' });

    // Totales
    const totalItems = Number(
      items.reduce((a, it) => a + Number(it?.monto || 0), 0).toFixed(2)
    );

    // Acumulado del día
    const { rows: accRows } = await pool.query(
      `SELECT COALESCE(SUM(total),0)::numeric(12,2) AS acc FROM historial WHERE dni=$1 AND fecha=$2`,
      [dni, fecha]
    );
    const acc = Number(accRows[0].acc);
    if (acc + totalItems > TOPE) {
      return res.status(400).json({
        msg: `Supera el tope diario. Acumulado S/ ${acc.toFixed(2)} + nuevo S/ ${totalItems.toFixed(2)} > TOPE S/ ${TOPE.toFixed(2)}`
      });
    }

    // Correlativo por DNI
    const n = await nextCorrelativo(dni);
    const serie = `YRLE001`; // puedes cambiar la serie a lo que gustes
    const num = n;

    await pool.query(
      `INSERT INTO historial(dni,email,empresaid,fecha,serie,num,items,total)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [dni, email, u.empresaid, fecha, serie, num, JSON.stringify(items), totalItems]
    );

    // Empresa para PDF
    let empresa = null;
    if (u.empresaid) {
      const r = await pool.query(`SELECT id, razon, ruc, direccion FROM empresas WHERE id=$1`, [u.empresaid]);
      empresa = r.rowCount ? r.rows[0] : null;
    }

    res.json({
      ok: true,
      fecha,
      total: totalItems,
      serie, num,
      empresa
    });
  } catch (e) { next(e); }
});

// Historial (si ?all=1 requiere PIN admin, sino propio)
app.get('/api/historial', async (req, res, next) => {
  try {
    const all = String(req.query.all || '0') === '1';
    if (all) requireAdmin(req);

    let rows;
    if (all) {
      ({ rows } = await pool.query(
        `SELECT id, dni, email, empresaid, fecha, serie, num, total, items, created_at
         FROM historial ORDER BY created_at DESC LIMIT 500`
      ));
    } else {
      const email = String(req.query.email || '').trim();
      const dni = String(req.query.dni || '').trim();
      if (!email && !dni) return res.status(400).json({ msg: 'dni o email requerido' });
      ({ rows } = await pool.query(
        `SELECT id, dni, email, empresaid, fecha, serie, num, total, items, created_at
         FROM historial
         WHERE ($1='' OR lower(email)=lower($1)) OR ($2='' OR dni=$2)
         ORDER BY created_at DESC LIMIT 300`,
        [email, dni]
      ));
    }
    res.json(rows);
  } catch (e) { next(e); }
});

/* ===== ADMIN (simple por PIN en header x-admin-pin) ===== */

// Upsert empresas (lista completa)
app.put('/api/empresas', async (req, res, next) => {
  try {
    requireAdmin(req);
    const items = Array.isArray(req.body) ? req.body : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const e of items) {
        await client.query(
          `INSERT INTO empresas(id, razon, ruc, direccion, telefono, logo)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE
           SET razon=excluded.razon, ruc=excluded.ruc, direccion=excluded.direccion,
               telefono=excluded.telefono, logo=excluded.logo`,
          [e.id, e.razon, e.ruc, e.direccion || '', e.telefono || '', e.logo || '']
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT id, razon, ruc, direccion, telefono, logo FROM empresas ORDER BY id`);
    res.json(rows);
  } catch (e) { next(e); }
});

// Upsert usuarios (lista completa) + elimina si _delete=true
app.put('/api/usuarios', async (req, res, next) => {
  try {
    requireAdmin(req);
    const items = Array.isArray(req.body) ? req.body : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of items) {
        if (u._delete) {
          await client.query(`DELETE FROM usuarios WHERE lower(email)=lower($1)`, [u.email]);
          continue;
        }
        await client.query(
          `INSERT INTO usuarios(email, dni, nombres, apellidos, rol, activo, empresaid, proydef, proys)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (email) DO UPDATE
           SET dni=excluded.dni, nombres=excluded.nombres, apellidos=excluded.apellidos,
               rol=excluded.rol, activo=excluded.activo, empresaid=excluded.empresaid,
               proydef=excluded.proydef, proys=excluded.proys`,
          [
            u.email, u.dni, u.nombres, u.apellidos, u.rol || 'USUARIO',
            (u.activo === false ? false : true),
            u.empresaid || null,
            u.proydef || '',
            Array.isArray(u.proys) ? u.proys : []
          ]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const { rows } = await pool.query(
      `SELECT email,dni,nombres,apellidos,rol,activo,empresaid,proydef,COALESCE(proys,ARRAY[]::text[]) AS proys
       FROM usuarios ORDER BY apellidos, nombres`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

/* ========= Static (frontend) ========= */
app.use(express.static(path.join(__dirname, 'public')));

/* ========= Error handler ========= */
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ msg: err.message || 'Error interno' });
});

/* ========= Start ========= */
bootstrap()
  .then(() => app.listen(PORT, () => console.log(`API lista en :${PORT}`)))
  .catch(e => {
    console.error('Bootstrap error', e);
    process.exit(1);
  });

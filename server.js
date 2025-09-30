// server.js
// API Planilla de Movilidad (Node + Express + PostgreSQL/Neon)
// - Tablas auto-creadas si no existen
// - Vista de login (normaliza email y castea 'activo' a boolean)
// - Endpoints: /api/login, /api/empresas, /api/usuarios, /api/counters/next, /api/historial, /api/health

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // logos en base64
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Conexión Neon ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon/Render
});

async function q(sql, params = []) {
  const res = await pool.query(sql, params);
  return res;
}

// ---------- Util ----------
function stripAccents(s = '') {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}
function serieFromName(nombres = '', apellidos = '') {
  const a = stripAccents(String(nombres)).trim().toUpperCase();
  const b = stripAccents(String(apellidos)).trim().toUpperCase();
  return (a.slice(0, 2) + b.slice(0, 2) + '001'); // ej. YRLE001
}
function pad5(n) {
  return String(n).padStart(5, '0');
}

// ---------- Bootstrap DB ----------
async function bootstrap() {
  // 1) Empresas
  await q(`
    CREATE TABLE IF NOT EXISTS empresas (
      id        TEXT PRIMARY KEY,
      razon     TEXT NOT NULL DEFAULT '',
      ruc       TEXT,
      direccion TEXT,
      telefono  TEXT,
      logo      TEXT
    );
  `);

  // 2) Usuarios (activo INT 0/1 para no romper instalaciones previas)
  await q(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id         BIGSERIAL PRIMARY KEY,
      activo     INTEGER NOT NULL DEFAULT 1,
      dni        TEXT UNIQUE NOT NULL,
      nombres    TEXT,
      apellidos  TEXT,
      email      TEXT UNIQUE,
      empresaid  TEXT REFERENCES empresas(id) ON DELETE SET NULL,
      rol        TEXT,
      proydef    TEXT,
      proys      TEXT
    );
  `);

  // 3) Contadores por DNI (para numeración)
  await q(`
    CREATE TABLE IF NOT EXISTS counters (
      dni TEXT PRIMARY KEY,
      n   INTEGER NOT NULL DEFAULT 0
    );
  `);

  // 4) Historial
  await q(`
    CREATE TABLE IF NOT EXISTS historial (
      id         BIGSERIAL PRIMARY KEY,
      serie      TEXT,
      num        TEXT,
      fecha      DATE,
      dni        TEXT,
      email      TEXT,
      trabajador TEXT,
      proyecto   TEXT,
      destino    TEXT,
      motivo     TEXT,
      pc         TEXT,
      monto      NUMERIC(12,2) NOT NULL DEFAULT 0,
      total      NUMERIC(12,2) NOT NULL DEFAULT 0
    );
  `);

  // 5) Vista de login: email en lower + 'activo' boolean
  await q(`DROP VIEW IF EXISTS v_usuarios_login;`);
  await q(`
    CREATE VIEW v_usuarios_login AS
    SELECT
      u.id,
      lower(u.email) AS email,
      (u.activo <> 0) AS activo,
      u.dni,
      u.nombres,
      u.apellidos,
      u.rol,
      u.empresaid,
      e.razon,
      e.ruc,
      e.direccion,
      e.telefono,
      e.logo
    FROM usuarios u
    LEFT JOIN empresas e ON e.id = u.empresaid;
  `);

  // 6) Seed mínimo si está vacío (opcional)
  const { rows: ru } = await q(`SELECT COUNT(*)::INT AS c FROM usuarios;`);
  if (!ru[0].c) {
    // Empresas demo
    await q(`
      INSERT INTO empresas (id, razon, ruc, direccion, telefono, logo) VALUES
        ('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331',''),
        ('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331','')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Usuarios demo
    await q(`
      INSERT INTO usuarios (activo, dni, nombres, apellidos, email, empresaid, rol, proydef, proys)
      VALUES
        (1,'44895702','YRVING','LEON','admin@empresa.com','INV_PADOVA','ADMIN_PADOVA','ADMIN PADOVA','ADMIN PADOVA,LITORAL 900,SANTA BEATRIZ'),
        (1,'44081950','JOEL','GARGATE','usuario@empresa.com','CONS_PADOVA','USUARIO','SANTA BEATRIZ','SANTA BEATRIZ')
      ON CONFLICT (email) DO NOTHING;
    `);

    // Contadores en 0 (próximo: 00001)
    await q(`
      INSERT INTO counters (dni,n) VALUES
        ('44895702',0),('44081950',0)
      ON CONFLICT (dni) DO UPDATE SET n = EXCLUDED.n;
    `);
  }
}

// ---------- Endpoints ----------

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Login (demo: valida sólo existencia/activo)
app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ ok:false, msg:'Email requerido' });

    const { rows } = await q(
      `SELECT * FROM v_usuarios_login WHERE email = $1 LIMIT 1;`,
      [email]
    );
    if (!rows.length || rows[0].activo !== true) {
      return res.status(401).json({ ok:false, msg:'Usuario no existe o inactivo' });
    }

    res.json({ ok:true, user: rows[0] });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ ok:false, msg:'Error login' });
  }
});

// Empresas
app.get('/api/empresas', async (_req, res) => {
  try {
    const { rows } = await q(`SELECT * FROM empresas ORDER BY id;`);
    res.json({ ok:true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

app.post('/api/empresas', async (req, res) => {
  try {
    const { id, razon, ruc, direccion, telefono, logo } = req.body;
    if (!id) return res.status(400).json({ ok:false, msg:'id requerido' });

    await q(`
      INSERT INTO empresas (id, razon, ruc, direccion, telefono, logo)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET
        razon     = EXCLUDED.razon,
        ruc       = EXCLUDED.ruc,
        direccion = EXCLUDED.direccion,
        telefono  = EXCLUDED.telefono,
        logo      = EXCLUDED.logo
    `, [id, razon||'', ruc||'', direccion||'', telefono||'', logo||'']);

    res.json({ ok:true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

app.put('/api/empresas/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { razon, ruc, direccion, telefono, logo } = req.body;
    await q(`
      UPDATE empresas SET
        razon=$2, ruc=$3, direccion=$4, telefono=$5, logo=$6
      WHERE id=$1
    `, [id, razon||'', ruc||'', direccion||'', telefono||'', logo||'']);
    res.json({ ok:true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

app.delete('/api/empresas/:id', async (req, res) => {
  try {
    await q(`DELETE FROM empresas WHERE id=$1`, [req.params.id]);
    res.json({ ok:true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

// Usuarios
app.get('/api/usuarios', async (_req, res) => {
  try {
    const { rows } = await q(`
      SELECT u.*, e.razon AS empresa_razon
      FROM usuarios u
      LEFT JOIN empresas e ON e.id = u.empresaid
      ORDER BY u.email;
    `);
    res.json({ ok:true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

app.post('/api/usuarios', async (req, res) => {
  try {
    const {
      activo = 1, dni, nombres='', apellidos='', email,
      empresaid=null, rol='USUARIO', proydef='', proys=''
    } = req.body;
    if (!dni || !email) return res.status(400).json({ ok:false, msg:'dni y email requeridos' });

    await q(`
      INSERT INTO usuarios (activo, dni, nombres, apellidos, email, empresaid, rol, proydef, proys)
      VALUES ($1,$2,$3,$4,lower($5),$6,$7,$8,$9)
      ON CONFLICT (email) DO UPDATE SET
        activo=$1, dni=$2, nombres=$3, apellidos=$4,
        empresaid=$6, rol=$7, proydef=$8, proys=$9
    `, [activo?1:0, dni, nombres, apellidos, email, empresaid, rol, proydef, proys]);

    // crea/asegura contador
    await q(`
      INSERT INTO counters (dni, n)
      VALUES ($1, 0)
      ON CONFLICT (dni) DO NOTHING;
    `, [dni]);

    res.json({ ok:true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

// Nota: si el DNI puede cambiar, pásalo en body como oldDni para migrar el contador
app.put('/api/usuarios/:dni', async (req, res) => {
  try {
    const dni = req.params.dni;
    const {
      activo = 1, nombres='', apellidos='', email,
      empresaid=null, rol='USUARIO', proydef='', proys='',
      newDni // opcional: si cambia el DNI
    } = req.body;

    // Actualiza usuario
    await q(`
      UPDATE usuarios SET
        activo=$2, nombres=$3, apellidos=$4, email=lower($5),
        empresaid=$6, rol=$7, proydef=$8, proys=$9,
        dni = COALESCE($10, dni)
      WHERE dni=$1
    `, [dni, activo?1:0, nombres, apellidos, email, empresaid, rol, proydef, proys, newDni||null]);

    // Asegura counter del nuevo DNI
    const currentDni = newDni || dni;
    await q(`
      INSERT INTO counters (dni, n) VALUES ($1, 0)
      ON CONFLICT (dni) DO NOTHING;
    `, [currentDni]);

    res.json({ ok:true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

app.delete('/api/usuarios/:dni', async (req, res) => {
  try {
    const dni = req.params.dni;
    await q(`DELETE FROM usuarios WHERE dni=$1`, [dni]);
    // opcional: borrar el counter
    // await q(`DELETE FROM counters WHERE dni=$1`, [dni]);
    res.json({ ok:true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

// NEXT number por DNI (incrementa y devuelve {serie,num})
app.post('/api/counters/next', async (req, res) => {
  try {
    const dni = String(req.body.dni||'').trim();
    if (!dni) return res.status(400).json({ ok:false, msg:'dni requerido' });

    // Asegura fila counter
    await q(`
      INSERT INTO counters (dni,n) VALUES ($1,0)
      ON CONFLICT (dni) DO NOTHING;
    `, [dni]);

    // Sube n y devuelve
    const { rows } = await q(
      `UPDATE counters SET n = n + 1 WHERE dni=$1 RETURNING n;`, [dni]
    );
    const num = pad5(rows[0].n);

    // Lee persona para serie
    const r2 = await q(`SELECT nombres, apellidos FROM usuarios WHERE dni=$1 LIMIT 1;`, [dni]);
    const { nombres='', apellidos='' } = r2.rows[0] || {};
    const serie = serieFromName(nombres, apellidos);

    res.json({ ok:true, serie, num });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

// Guardar planilla (batch)
app.post('/api/historial', async (req, res) => {
  // body: { dni, fecha, detalles: [{destino,motivo,proyecto,pc,monto}], total? }
  try {
    const dni   = String(req.body.dni||'').trim();
    const fecha = String(req.body.fecha||'').trim();
    const detalles = Array.isArray(req.body.detalles) ? req.body.detalles : [];
    if (!dni || !fecha || !detalles.length) {
      return res.status(400).json({ ok:false, msg:'dni, fecha y detalles requeridos' });
    }

    // usuario
    const ru = await q(`SELECT email, nombres, apellidos FROM usuarios WHERE dni=$1 LIMIT 1;`, [dni]);
    if (!ru.rows.length) return res.status(400).json({ ok:false, msg:'Usuario no encontrado' });
    const email = (ru.rows[0].email||'').toLowerCase();
    const trabajador = `${ru.rows[0].nombres||''} ${ru.rows[0].apellidos||''}`.trim();

    // correlativo
    const next = await q(`UPDATE counters SET n=n+1 WHERE dni=$1 RETURNING n;`, [dni]);
    if (!next.rows.length) {
      // si no existía counter, lo creamos y ponemos 1
      await q(`INSERT INTO counters (dni,n) VALUES ($1,1) ON CONFLICT (dni) DO UPDATE SET n=1 RETURNING n;`, [dni]);
    }
    const { rows: rN } = await q(`SELECT n FROM counters WHERE dni=$1;`, [dni]);
    const num   = pad5(rN[0].n);
    const serie = serieFromName(ru.rows[0].nombres, ru.rows[0].apellidos);

    // total
    const total = (req.body.total != null)
      ? Number(req.body.total)
      : detalles.reduce((s,d)=>s + (Number(d.monto)||0), 0);

    // inserta filas
    const text = `
      INSERT INTO historial (serie, num, fecha, dni, email, trabajador, proyecto, destino, motivo, pc, monto, total)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `;
    for (const d of detalles) {
      await q(text, [
        serie, num, fecha, dni, email, trabajador,
        (d.proyecto||'').toUpperCase(),
        (d.destino||'').toUpperCase(),
        (d.motivo||'').toUpperCase(),
        String(d.pc||''),
        Number(d.monto)||0,
        Number(total)||0
      ]);
    }

    res.json({ ok:true, serie, num, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

// Listado historial
// - ?email= filtra por usuario
// - ?dni=   filtra por DNI
// - ?all=1  trae todo
app.get('/api/historial', async (req, res) => {
  try {
    const { email, dni, all } = req.query;
    let rows;
    if (all === '1') {
      ({ rows } = await q(`SELECT * FROM historial ORDER BY id DESC LIMIT 1000;`));
    } else if (dni) {
      ({ rows } = await q(`SELECT * FROM historial WHERE dni=$1 ORDER BY id DESC LIMIT 1000;`, [dni]));
    } else if (email) {
      ({ rows } = await q(`SELECT * FROM historial WHERE lower(email)=lower($1) ORDER BY id DESC LIMIT 1000;`, [email]));
    } else {
      // por seguridad, vacío si no hay filtro
      rows = [];
    }
    res.json({ ok:true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});

// ---------- Start ----------
bootstrap()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API corriendo en http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Fallo bootstrap DB:', err);
    process.exit(1);
  });

// src/routes/admin.js
import { Router } from 'express';
import { requireAuth } from '../Middleware/auth.js';
import { getClient, query } from '../db.js';

const router = Router();

// Guardado masivo de empresas (upsert por id)
router.put('/empresas', requireAuth, async (req, res) => {
  if (req.user.rol !== 'ADMIN_PADOVA') return res.status(403).json({ error: 'No autorizado' });
  const list = Array.isArray(req.body) ? req.body : [];
  const client = await getClient();

  try {
    await client.query('BEGIN');
    for (const e of list) {
      await client.query(
        `INSERT INTO empresas (id, razon, ruc, direccion, telefono, logo)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE
           SET razon=EXCLUDED.razon,
               ruc=EXCLUDED.ruc,
               direccion=EXCLUDED.direccion,
               telefono=EXCLUDED.telefono,
               logo=EXCLUDED.logo`,
        [e.id, e.razon, e.ruc, e.direccion || null, e.telefono || null, e.logo || null]
      );
    }
    await client.query('COMMIT');

    const { rows } = await query(`SELECT id, razon, ruc, direccion, telefono, logo FROM empresas ORDER BY razon`);
    res.json(rows);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    console.error('PUT /empresas', e);
    res.status(500).json({ error: 'No se pudo guardar empresas' });
  } finally {
    client.release();
  }
});

// Guardado masivo de usuarios (upsert por email)
router.put('/usuarios', requireAuth, async (req, res) => {
  if (req.user.rol !== 'ADMIN_PADOVA') return res.status(403).json({ error: 'No autorizado' });
  const list = Array.isArray(req.body) ? req.body : [];
  const client = await getClient();

  try {
    await client.query('BEGIN');
    for (const u of list) {
      const proyectosArr = Array.isArray(u.proyectos)
        ? u.proyectos
        : String(u.proyectos || '')
            .split(',')
            .map(s => s.trim().toUpperCase())
            .filter(Boolean);

      await client.query(
        `INSERT INTO usuarios (id, activo, dni, nombres, apellidos, email, rol, empresa_id, proy_def, proyectos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (email) DO UPDATE
           SET activo=EXCLUDED.activo,
               dni=EXCLUDED.dni,
               nombres=EXCLUDED.nombres,
               apellidos=EXCLUDED.apellidos,
               rol=EXCLUDED.rol,
               empresa_id=EXCLUDED.empresa_id,
               proy_def=EXCLUDED.proy_def,
               proyectos=EXCLUDED.proyectos`,
        [
          u.id || null,
          Boolean(u.activo),
          String(u.dni),
          (u.nombres || '').toUpperCase(),
          (u.apellidos || '').toUpperCase(),
          String(u.email).toLowerCase(),
          u.rol,
          u.empresaId,
          (u.proyDef || '').toUpperCase(),
          proyectosArr
        ]
      );
    }
    await client.query('COMMIT');

    const { rows } = await query(
      `SELECT id, activo, dni, nombres, apellidos, email, rol, empresa_id, proy_def, proyectos
         FROM usuarios
        ORDER BY apellidos, nombres`
    );
    res.json(rows);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    console.error('PUT /usuarios', e);
    res.status(500).json({ error: 'No se pudo guardar usuarios' });
  } finally {
    client.release();
  }
});

export default router;

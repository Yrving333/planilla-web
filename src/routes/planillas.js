import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query, getClient } from '../db.js';
import { normalize, serieFromName } from '../utils.js';

const TOPE = Number(process.env.TOPE || 45);
const router = Router();

/**
 * Empresas:
 * - Si ?simple=1 -> público (para que el front pinte encabezado antes de login)
 * - Sin ?simple -> requiere token
 */
router.get('/empresas', async (req, res) => {
  try {
    const simple = String(req.query.simple || '') === '1';
    const cols = simple ? 'id, razon, ruc' : 'id, razon, ruc, direccion, telefono, logo';
    const { rows } = await query(`SELECT ${cols} FROM empresas ORDER BY razon`);
    if (!simple) {
      // forzar auth si NO es simple
      return requireAuth(req, res, () => res.json(rows));
    }
    return res.json(rows);
  } catch (e) {
    console.error('GET /empresas', e);
    res.status(500).json({ error: 'Error listando empresas' });
  }
});

/** Usuarios (admin ve todos; usuario sólo el suyo) */
router.get('/usuarios', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.rol === 'ADMIN_PADOVA';
    const params = [];
    let sql = `SELECT id, activo, dni, nombres, apellidos, email, rol, empresa_id, proy_def, proyectos FROM usuarios`;
    if (!isAdmin) { sql += ` WHERE LOWER(email) = $1`; params.push(req.user.email.toLowerCase()); }
    sql += ` ORDER BY apellidos, nombres`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('GET /usuarios', e);
    res.status(500).json({ error: 'Error listando usuarios' });
  }
});

/** Acumulado del día (por dni/fecha) */
router.get('/acumulado', requireAuth, async (req, res) => {
  try {
    const dni = String(req.query.dni || '').trim();
    const fecha = String(req.query.fecha || '').trim();
    if (!dni || !fecha) return res.status(400).json({ error: 'dni y fecha requeridos' });
    if (req.user.rol !== 'ADMIN_PADOVA' && dni !== req.user.dni) return res.status(403).json({ error: 'No autorizado' });

    const { rows } = await query(
      `SELECT COALESCE(SUM(total),0) AS acumulado FROM planilla WHERE dni=$1 AND fecha=$2`,
      [dni, fecha]
    );
    res.json({ acumulado: Number(rows[0]?.acumulado || 0) });
  } catch (e) {
    console.error('GET /acumulado', e);
    res.status(500).json({ error: 'Error consultando acumulado' });
  }
});

/** Crear planilla + detalle (server valida tope y genera correlativo) */
router.post('/planillas', requireAuth, async (req, res) => {
  const client = await getClient();
  try {
    const { fecha, detalles } = req.body || {};
    if (!fecha || !Array.isArray(detalles) || detalles.length === 0)
      return res.status(400).json({ error: 'fecha y detalles requeridos' });

    const u = req.user;
    const serie = serieFromName(normalize(u.nombres), normalize(u.apellidos));

    // siguiente correlativo por dni
    const { rows: rn } = await client.query(
      `SELECT COALESCE(MAX(num),0)+1 AS next FROM planilla WHERE dni=$1`, [u.dni]
    );
    const num = Number(rn[0].next || 1);
    const total = detalles.reduce((s, d) => s + Number(d.monto || 0), 0);

    // tope por día
    const { rows: ra } = await client.query(
      `SELECT COALESCE(SUM(total),0) AS acumulado FROM planilla WHERE dni=$1 AND fecha=$2`,
      [u.dni, fecha]
    );
    const acumuladoHoy = Number(ra[0]?.acumulado || 0);
    if (acumuladoHoy + total > TOPE) return res.status(400).json({ error: `Tope diario ${TOPE} excedido` });

    await client.query('BEGIN');

    const trabajador = `${u.nombres} ${u.apellidos}`;

    const { rows: rCab } = await client.query(
      `INSERT INTO planilla (serie,num,fecha,usuario_id,dni,trabajador,email,total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [serie, num, fecha, u.id, u.dni, trabajador, u.email.toLowerCase(), total]
    );
    const planillaId = rCab[0].id;

    const text = `INSERT INTO planilla_detalle (planilla_id, proyecto, destino, motivo, pc, monto)
                  VALUES ($1,$2,$3,$4,$5,$6)`;
    for (const d of detalles) {
      await client.query(text, [
        (planillaId),
        (d.proyecto || u.proy_def || '').toString().toUpperCase(),
        (d.destino  || '').toString().toUpperCase(),
        (d.motivo   || '').toString().toUpperCase(),
        (d.pc       || '').toString(),
        Number(d.monto || 0)
      ]);
    }

    await client.query('COMMIT');
    res.json({ serie, num, total });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    console.error('POST /planillas', e);
    res.status(500).json({ error: 'Error guardando planilla' });
  } finally {
    client.release();
  }
});

/** Historial (admin: todos; usuario: solo sus planillas) */
router.get('/planillas', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.rol === 'ADMIN_PADOVA';
    const params = [];
    let sql =
      `SELECT p.serie, p.num, p.fecha, p.trabajador, p.email, p.dni, p.total,
              d.proyecto, d.destino, d.motivo, d.pc, d.monto
         FROM planilla p
         JOIN planilla_detalle d ON d.planilla_id = p.id`;
    if (!isAdmin) { sql += ` WHERE LOWER(p.email) = $1`; params.push(req.user.email.toLowerCase()); }
    sql += ` ORDER BY p.fecha DESC, p.serie, p.num DESC, d.id ASC`;

    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('GET /planillas', e);
    res.status(500).json({ error: 'Error listando planillas' });
  }
});

export default router;

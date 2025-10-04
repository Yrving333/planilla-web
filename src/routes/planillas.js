import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { q } from '../db.js';

const r = Router();

function auth(req, res, next) {
  const m = (req.headers.authorization||'').match(/^Bearer (.+)$/i);
  if (!m) return res.status(401).json({ error: 'token requerido' });
  try { req.user = jwt.verify(m[1], process.env.JWT_SECRET); return next(); }
  catch { return res.status(401).json({ error: 'token inválido' }); }
}

r.get('/historial', auth, async (req, res) => {
  const dni = req.query.dni || req.user?.dni;
  if (!dni) return res.json([]);
  const { rows } = await q(`
    select d.id, p.serie, p.num, to_char(p.fecha,'YYYY-MM-DD') as fecha,
           p.dni, p.trabajador, p.email, d.proyecto, d.destino, d.motivo, d.pc, d.monto, p.total
      from planilla p
      join planilla_detalle d on d.planilla_id = p.id
     where p.dni = $1
     order by p.created_at desc, d.id desc
  `, [dni]);
  res.json(rows);
});

r.post('/historial', auth, async (req, res) => {
  const records = req.body?.records || [];
  if (!Array.isArray(records) || !records.length) return res.json({ ok: true, saved: 0 });

  const f = records[0];
  const up = await q(`
    insert into planilla(serie,num,fecha,usuario_id,dni,trabajador,email,total)
    values ($1,$2,$3,null,$4,$5,$6,$7)
    on conflict (serie,num) do update set total = excluded.total
    returning id
  `, [f.serie, f.num, f.fecha, f.dni, f.trabajador, f.email, f.total]);

  const pid = up.rows[0].id;

  await q(`delete from planilla_detalle where planilla_id=$1`, [pid]);

  const params = [];
  const values = records.map((r, i) => {
    params.push(pid, r.proyecto||'', r.destino||'', r.motivo||'', r.pc||'', r.monto||0);
    const o = params.length;
    return `($${o-5},$${o-4},$${o-3},$${o-2},$${o-1},$${o})`;
  });

  if (values.length) {
    await q(`insert into planilla_detalle(planilla_id,proyecto,destino,motivo,pc,monto) values ${values.join(',')}`, params);
  }
  res.json({ ok: true, saved: records.length });
});

export default r;

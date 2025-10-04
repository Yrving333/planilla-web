import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { q } from '../db.js';

const r = Router();

r.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email/password requeridos' });

  const { rows } = await q(`
    select u.*, e.id as emp_id, e.razon, e.ruc, e.direccion, e.telefono, e.logo
      from usuarios u
      join empresas e on e.id = u.empresa_id
     where lower(u.email) = lower($1)
       and u.activo = true
       and u.password_hash = crypt($2, u.password_hash)
  `, [email, password]);

  const u = rows[0];
  if (!u) return res.status(401).json({ error: 'Credenciales inválidas' });

  const token = jwt.sign({ sub: u.id, email: u.email, rol: u.rol, dni: u.dni }, process.env.JWT_SECRET, { expiresIn: '8h' });

  res.json({
    token,
    usuario: {
      id: u.id, dni: u.dni, nombres: u.nombres, apellidos: u.apellidos,
      email: u.email, rol: u.rol,
      proy_def: u.proy_def, proyectos: u.proyectos,
      empresa: { id: u.emp_id, razon: u.razon, ruc: u.ruc, direccion: u.direccion, telefono: u.telefono, logo: u.logo }
    }
  });
});

export default r;

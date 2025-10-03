import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const router = Router();

/**
 * DEMO_LOGIN=true permite login solo con email.
 * Si DEMO_LOGIN != 'true', aquí deberías validar password_hash (bcrypt).
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const emailLc = String(email || '').toLowerCase();
    if (!emailLc) return res.status(400).json({ error: 'Email requerido' });

    const { rows } = await query(
      `SELECT u.*, e.razon AS empresa_razon, e.ruc AS empresa_ruc, e.direccion AS empresa_direccion,
              e.telefono AS empresa_telefono, e.logo AS empresa_logo
         FROM usuarios u
         JOIN empresas e ON e.id = u.empresa_id
        WHERE LOWER(u.email) = $1 AND u.activo = TRUE`,
      [emailLc]
    );
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Usuario no encontrado o inactivo' });

    const allowDemo = String(process.env.DEMO_LOGIN || 'true').toLowerCase() === 'true';
    if (!allowDemo) {
      // Aquí iría: if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401)...
      return res.status(501).json({ error: 'Auth real no implementada' });
    }

    const usuario = {
      id: u.id,
      dni: u.dni,
      email: u.email.toLowerCase(),
      rol: u.rol,
      empresa_id: u.empresa_id,
      nombres: u.nombres,
      apellidos: u.apellidos,
      proy_def: u.proy_def,
      proyectos: u.proyectos || [],
      empresa: {
        id: u.empresa_id,
        razon: u.empresa_razon,
        ruc: u.empresa_ruc,
        direccion: u.empresa_direccion,
        telefono: u.empresa_telefono,
        logo: u.empresa_logo
      }
    };

    const token = jwt.sign(usuario, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, usuario });
  } catch (e) {
    console.error('POST /login', e);
    res.status(500).json({ error: 'Error en login' });
  }
});

export default router;


// src/Middleware/auth.js
import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  try {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Falta token' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    console.error('Auth error', e);
    res.status(401).json({ error: 'Token inválido' });
  }
}


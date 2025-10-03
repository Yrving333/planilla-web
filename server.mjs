import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import authRouter from './src/routes/auth.js';
import planillasRouter from './src/routes/planillas.js';
import { query } from './src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const DEBUG = String(process.env.DEBUG_ERRORS || 'false').toLowerCase() === 'true';

// ---- Middlewares base
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));
app.use(express.json({
  limit: '1mb',
  type: ['application/json', 'application/*+json', '*/json']
}));
app.use(cookieParser());

// ---- CORS
const ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({
  origin: ORIGIN === '*' ? true : ORIGIN,
  credentials: true,
}));

// ---- Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'dev' });
});

// ---- Diagnóstico (revisa ENV y DB sin exponer secretos)
app.get('/api/diag', async (_req, res) => {
  const flags = {
    has_DATABASE_URL: !!process.env.DATABASE_URL,
    has_JWT_SECRET: !!process.env.JWT_SECRET,
    DEMO_LOGIN: process.env.DEMO_LOGIN || null,
    DEBUG_ERRORS: process.env.DEBUG_ERRORS || null,
    NODE_ENV: process.env.NODE_ENV || null
  };
  try {
    const { rows } = await query('SELECT 1 AS ok');
    return res.json({ ok: true, db_ok: rows?.[0]?.ok === 1, flags });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      db_ok: false,
      flags,
      detail: DEBUG ? (e?.message || String(e)) : undefined
    });
  }
});

// ---- Echo para validar JSON recibido
app.post('/api/echo', (req, res) => {
  res.json({ ok: true, body: req.body });
});

// ---- Rutas de negocio
app.use('/api', authRouter);
app.use('/api', planillasRouter);

// ---- Static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Manejador de errores de parseo JSON (400 si el JSON es inválido)
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    if (DEBUG) console.error('JSON parse error:', err);
    return res.status(400).json({
      error: 'JSON inválido',
      detail: DEBUG ? (err.message || String(err)) : undefined
    });
  }
  return next(err);
});

// ---- Error handler global
app.use((err, _req, res, _next) => {
  if (DEBUG) console.error('UNHANDLED ERROR', err);
  res.status(500).json({
    error: 'Internal error',
    detail: DEBUG ? (err?.message || String(err)) : undefined
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CORS
const corsOrigin = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigin.length ? corsOrigin : true, credentials: true }));

app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));

// Rutas API
import authRouter from './src/routes/auth.js';
import planillasRouter from './src/routes/planillas.js';

app.use('/api', authRouter);
app.use('/api', planillasRouter);

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'dev' }));

// Static (front)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server listening on :${port}`));

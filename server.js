import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DATA_PATH || "data.db";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" })); // para logos base64 y bulk
app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET || "cambia-esto-en-produccion";
const TOPE = 45.0;

// ---------- BD ----------
const db = new Database(DB_PATH);

// tablas
db.exec(`
CREATE TABLE IF NOT EXISTS empresas (
  id TEXT PRIMARY KEY,
  razon TEXT NOT NULL,
  ruc TEXT NOT NULL,
  direccion TEXT,
  telefono TEXT,
  logo TEXT
);
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activo INTEGER DEFAULT 1,
  dni TEXT UNIQUE NOT NULL,
  nombres TEXT NOT NULL,
  apellidos TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  empresaId TEXT NOT NULL REFERENCES empresas(id),
  rol TEXT NOT NULL,
  proyDef TEXT,
  proyectos TEXT, -- CSV
  password_hash TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  dni TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serie TEXT NOT NULL,
  num TEXT NOT NULL,
  fecha TEXT NOT NULL, -- YYYY-MM-DD
  dni TEXT NOT NULL,
  email TEXT,
  trabajador TEXT,
  proyecto TEXT,
  destino TEXT,
  motivo TEXT,
  pc TEXT,
  monto REAL NOT NULL,
  total REAL NOT NULL
);
`);

// seed demo si BD vacía
const rowEmp = db.prepare("SELECT COUNT(*) c FROM empresas").get();
if (rowEmp.c === 0) {
  const direccion = "JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA";
  const tel = "495-1331";
  db.prepare(`INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
    VALUES (?,?,?,?,?,?)`).run("INV_PADOVA","INVERSIONES PADOVA S.A.C.","20523824598",direccion,tel,"");
  db.prepare(`INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
    VALUES (?,?,?,?,?,?)`).run("CONS_PADOVA","CONSTRUCTORA PADOVA S.A.C.","20601444341",direccion,tel,"");
}

const rowUsr = db.prepare("SELECT COUNT(*) c FROM usuarios").get();
if (rowUsr.c === 0) {
  const pAdmin = bcrypt.hashSync("admin123", 8);
  const pUser  = bcrypt.hashSync("usuario123", 8);
  db.prepare(`INSERT INTO usuarios(dni,nombres,apellidos,email,empresaId,rol,proyDef,proyectos,password_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("44895702","YRVING","LEON","admin@empresa.com","INV_PADOVA","ADMIN_PADOVA","ADMIN PADOVA","ADMIN PADOVA,LITORAL 900,SANTA BEATRIZ",pAdmin);
  db.prepare(`INSERT INTO usuarios(dni,nombres,apellidos,email,empresaId,rol,proyDef,proyectos,password_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("44081950","JOEL","GARGATE","usuario@empresa.com","CONS_PADOVA","USUARIO","SANTA BEATRIZ","SANTA BEATRIZ",pUser);
}

// helpers
const serieFromName = (n, a) =>
  (n.slice(0, 2) + a.slice(0, 2)).toUpperCase() + "001";

const normalizar = (t = "") =>
  t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// auth middlewares
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}
function onlyAdmin(req, res, next) {
  if (req.user?.rol === "ADMIN_PADOVA") return next();
  return res.status(403).json({ error: "Solo administradores" });
}

// ---------- Auth ----------
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email requerido" });
  const u = db.prepare("SELECT * FROM usuarios WHERE email = ? AND activo = 1").get(String(email).toLowerCase());
  if (!u) return res.status(401).json({ error: "Usuario no existe o inactivo" });

  // password opcional (si no hay hash, permite solo con email)
  if (u.password_hash) {
    const ok = bcrypt.compareSync(password || "", u.password_hash);
    if (!ok) return res.status(401).json({ error: "Clave incorrecta" });
  }

  const token = jwt.sign(
    { uid: u.id, email: u.email, dni: u.dni, rol: u.rol },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
  res.json({
    token,
    me: {
      email: u.email,
      dni: u.dni,
      rol: u.rol,
      nombres: u.nombres,
      apellidos: u.apellidos,
      empresaId: u.empresaId
    }
  });
});

// ---------- Empresas ----------
app.get("/api/empresas", auth, (req, res) => {
  const list = db.prepare("SELECT * FROM empresas ORDER BY id").all();
  res.json(list);
});

app.put("/api/empresas", auth, onlyAdmin, (req, res) => {
  const list = req.body || [];
  const up = db.prepare(`INSERT INTO empresas(id,razon,ruc,direccion,telefono,logo)
   VALUES (@id,@razon,@ruc,@direccion,@telefono,@logo)
   ON CONFLICT(id) DO UPDATE SET
   razon=excluded.razon,ruc=excluded.ruc,direccion=excluded.direccion,telefono=excluded.telefono,logo=excluded.logo`);
  const tx = db.transaction(arr => arr.forEach(e => up.run(e)));
  tx(list);
  res.json({ ok: true });
});

// ---------- Usuarios ----------
app.get("/api/usuarios", auth, (req, res) => {
  if (req.user.rol === "ADMIN_PADOVA") {
    const rows = db.prepare(`SELECT * FROM usuarios ORDER BY apellidos,nombres`).all();
    return res.json(rows);
  }
  const u = db.prepare("SELECT * FROM usuarios WHERE email=?").get(req.user.email);
  res.json([u]);
});

app.put("/api/usuarios", auth, onlyAdmin, (req, res) => {
  const list = req.body || [];
  const up = db.prepare(`INSERT INTO usuarios(dni,nombres,apellidos,email,empresaId,rol,proyDef,proyectos,activo)
    VALUES (@dni,@nombres,@apellidos,@email,@empresaId,@rol,@proyDef,@proyectos,@activo)
    ON CONFLICT(dni) DO UPDATE SET
      nombres=excluded.nombres, apellidos=excluded.apellidos, email=excluded.email,
      empresaId=excluded.empresaId, rol=excluded.rol, proyDef=excluded.proyDef,
      proyectos=excluded.proyectos, activo=excluded.activo`);
  const tx = db.transaction(arr => arr.forEach(u => up.run(u)));
  tx(list);
  res.json({ ok: true });
});

// ---------- Acumulado día ----------
app.get("/api/acumulado", auth, (req, res) => {
  const { dni, fecha } = req.query;
  if (!dni || !fecha) return res.status(400).json({ error: "dni y fecha requeridos" });
  const row = db.prepare(`
    SELECT IFNULL(SUM(t.total),0) total FROM (
      SELECT num, MAX(total) total
      FROM historial
      WHERE dni=? AND fecha=?
      GROUP BY num
    ) t
  `).get(dni, fecha);
  res.json({ total: Number(row.total || 0) });
});

// ---------- Historial ----------
app.get("/api/historial", auth, (req, res) => {
  let rows;
  if (req.user.rol === "ADMIN_PADOVA") {
    rows = db.prepare("SELECT * FROM historial ORDER BY id DESC").all();
  } else {
    rows = db.prepare("SELECT * FROM historial WHERE email=? OR dni=? ORDER BY id DESC").all(req.user.email, req.user.dni);
  }
  res.json(rows);
});

app.put("/api/historial", auth, onlyAdmin, (req, res) => {
  const list = req.body || [];
  const up = db.prepare(`UPDATE historial SET
    serie=@serie,num=@num,fecha=@fecha,trabajador=@trabajador,proyecto=@proyecto,
    destino=@destino,motivo=@motivo,pc=@pc,monto=@monto,total=@total
    WHERE id=@id`);
  const tx = db.transaction(arr => arr.forEach(r => up.run(r)));
  tx(list);
  res.json({ ok: true });
});

app.post("/api/historial/delete", auth, onlyAdmin, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: true, deleted: 0 });
  const del = db.prepare(`DELETE FROM historial WHERE id=?`);
  const tx = db.transaction(arr => arr.forEach(id => del.run(id)));
  tx(ids);
  res.json({ ok: true, deleted: ids.length });
});

// ---------- Planillas (guardar + tope + correlativo) ----------
app.post("/api/planillas", auth, (req, res) => {
  const { dni, fecha, detalles } = req.body || {};
  if (!dni || !fecha || !Array.isArray(detalles) || detalles.length === 0) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  const user = db.prepare("SELECT * FROM usuarios WHERE dni=?").get(dni);
  if (!user) return res.status(400).json({ error: "Trabajador no existe" });

  const totalPlanilla = detalles.reduce((s, d) => s + (Number(d.monto) || 0), 0);
  const acumRow = db.prepare(`
    SELECT IFNULL(SUM(t.total),0) total FROM (
      SELECT num, MAX(total) total
      FROM historial
      WHERE dni=? AND fecha=?
      GROUP BY num
    ) t
  `).get(dni, fecha);
  const acumulado = Number(acumRow.total || 0);
  if (acumulado + totalPlanilla > TOPE) {
    return res.status(400).json({
      error: "Tope diario superado",
      acumulado, disponible: Math.max(0, TOPE - acumulado)
    });
  }

  // correlativo por usuario
  const cRow = db.prepare("SELECT n FROM counters WHERE dni=?").get(dni);
  const next = (cRow?.n || 0) + 1;
  db.prepare(`INSERT INTO counters(dni,n) VALUES (?,?)
             ON CONFLICT(dni) DO UPDATE SET n=excluded.n`).run(dni, next);
  const num = String(next).padStart(5, "0");
  const serie = serieFromName(normalizar(user.nombres), normalizar(user.apellidos));

  const ins = db.prepare(`INSERT INTO historial
    (serie,num,fecha,dni,email,trabajador,proyecto,destino,motivo,pc,monto,total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(arr => {
    arr.forEach(d => {
      ins.run(serie, num, fecha, dni, user.email, `${user.nombres} ${user.apellidos}`,
        d.proyecto || user.proyDef || "", d.destino || "", d.motivo || "", d.pc || "",
        Number(d.monto) || 0, totalPlanilla);
    });
  });
  tx(detalles);

  res.json({ ok: true, serie, num, total: totalPlanilla });
});

// PC disponibles (por si quieres pedirlos al backend)
app.get("/api/pcs", auth, (_req, res) => {
  res.json(["94303", "95301", "95303", "234120502", "234120503"]);
});

// ---------- SPA ----------
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API corriendo en http://localhost:${PORT}`));

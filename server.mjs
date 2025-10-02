// server.mjs
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --------- ENV ----------
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;           // Neon / Render
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "").split(",").map(s=>s.trim()).filter(Boolean);
const TOPE = Number(process.env.TOPE || 45);              // tope por día

// --------- DB ----------
if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL en variables de entorno.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function q(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// --------- MIDDLEWARE ----------
app.use(express.json());
app.use(
  cors({
    origin: CORS_ORIGIN.length ? CORS_ORIGIN : true,
    credentials: true,
  })
);

// --------- ESTÁTICOS (ARREGLA "Cannot GET /") ----------
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

// --------- HEALTH ----------
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, env: process.env.NODE_ENV || "dev" })
);

// --------- LOGIN ----------
app.get("/api/login", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ msg: "Falta email" });

    // Usa la vista si existe; si no, cae al SELECT directo
    let row;
    try {
      const r = await q(
        `select email,dni,nombres,apellidos,rol,activo,empresaid,proydef,proys
         from v_usuarios_login
         where lower(email)=lower($1)
         limit 1`,
        [email]
      );
      row = r[0];
    } catch {
      const r = await q(
        `select 
           email,dni,nombres,apellidos,rol,
           case when coalesce(activo::text,'') in ('1','t','true','TRUE') then true else false end as activo,
           empresaid, proydef, coalesce(proys, array[]::text[]) as proys
         from usuarios
         where lower(email)=lower($1)
         limit 1`,
        [email]
      );
      row = r[0];
    }

    if (!row) return res.status(404).json({ msg: "Usuario no encontrado" });
    if (!row.activo) return res.status(403).json({ msg: "Usuario inactivo" });

    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Error login" });
  }
});

// --------- EMPRESAS ----------
app.get("/api/empresas", async (req, res) => {
  try {
    const simple = String(req.query.simple || "") === "1";
    if (simple) {
      const rows = await q(
        `select id, razon, ruc
           from empresas
           order by razon`
      );
      return res.json(rows);
    }
    const rows = await q(
      `select id, razon, ruc, direccion, telefono, logo
         from empresas
         order by razon`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Error empresas" });
  }
});

// --------- USUARIOS (para selector) ----------
app.get("/api/usuarios", async (_req, res) => {
  try {
    // muestra sólo campos necesarios
    const rows = await q(
      `select email, dni, nombres, apellidos, 
              case when coalesce(activo::text,'') in ('1','t','true','TRUE') 
                   then true else false end as activo,
              rol, empresaid, proydef, coalesce(proys, array[]::text[]) as proys
         from usuarios
         order by apellidos, nombres`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Error usuarios" });
  }
});

// --------- PLANILLAS: guardar ----------
app.post("/api/planillas", async (req, res) => {
  const { dni, email, fecha, items = [] } = req.body || {};
  if (!dni || !email) return res.status(400).json({ msg: "Faltan dni/email" });

  const total = (items || []).reduce((s, it) => s + Number(it?.monto || 0), 0);

  // tope por día/usuario
  if (total > TOPE + 1e-6) {
    return res
      .status(400)
      .json({ msg: `Has superado el tope de S/ ${TOPE.toFixed(2)}` });
  }

  try {
    // datos del usuario
    const [u] = await q(
      `select email, dni, nombres, apellidos, empresaid 
         from usuarios
        where lower(email)=lower($1)`,
      [email]
    );
    if (!u) return res.status(404).json({ msg: "Usuario no encontrado" });

    // empresa
    const [emp] = await q(
      `select id, razon, ruc, direccion from empresas where id=$1`,
      [u.empresaid]
    );

    // serie: iniciales
    const inicial = (u.nombres || "X").trim()[0] || "X";
    const inicial2 = (u.apellidos || "X").trim()[0] || "X";
    const serie = (inicial + inicial2).toUpperCase();

    // num correlativo por usuario
    const [{ next }] = await q(
      `select coalesce(max(num),0)+1 as next
         from planillas
        where lower(email)=lower($1)`,
      [email]
    );
    const num = String(next).padStart(5, "0");

    // guarda encabezado
    const [{ id: pid }] = await q(
      `insert into planillas (serie,num,fecha,dni,email,total,empresaid)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning id`,
      [serie, num, fecha || new Date().toISOString().slice(0, 10), dni, email, total, u.empresaid]
    );

    // guarda detalles
    for (const it of items) {
      await q(
        `insert into planillas_det (planilla_id,destino,motivo,proyecto,pc,monto)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          pid,
          (it.destino || "").toUpperCase(),
          (it.motivo || "").toUpperCase(),
          (it.proyecto || "").toUpperCase(),
          it.pc || "",
          Number(it.monto || 0),
        ]
      );
    }

    res.json({
      ok: true,
      serie,
      num,
      total,
      fecha,
      empresa: emp || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Error al guardar planilla" });
  }
});

// --------- PLANILLAS: historial ----------
app.get("/api/planillas", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    const rol = String(req.query.rol || "").trim();

    let rows;
    if (rol === "ADMIN_PADOVA") {
      rows = await q(
        `select p.id, p.serie, p.num, p.fecha, p.email, p.total
           from planillas p
          order by p.fecha desc, p.id desc
          limit 500`
      );
    } else {
      rows = await q(
        `select p.id, p.serie, p.num, p.fecha, p.email, p.total
           from planillas p
          where lower(p.email)=lower($1)
          order by p.fecha desc, p.id desc
          limit 200`,
        [email]
      );
    }
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Error historial" });
  }
});

// --------- START ----------
app.listen(PORT, () => {
  console.log(`Servidor listo en :${PORT}`);
});

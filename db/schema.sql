CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DROP TABLE IF EXISTS planilla_detalle CASCADE;
DROP TABLE IF EXISTS planilla CASCADE;
DROP TABLE IF EXISTS usuarios CASCADE;
DROP TABLE IF EXISTS empresas CASCADE;

CREATE TABLE empresas (
  id        VARCHAR(50) PRIMARY KEY,
  razon     TEXT NOT NULL,
  ruc       VARCHAR(20) NOT NULL,
  direccion TEXT,
  telefono  TEXT,
  logo      TEXT
);

CREATE TABLE usuarios (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activo     BOOLEAN NOT NULL DEFAULT true,
  dni        VARCHAR(8) UNIQUE NOT NULL,
  nombres    TEXT NOT NULL,
  apellidos  TEXT NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  rol        TEXT NOT NULL CHECK (rol IN ('ADMIN_PADOVA','USUARIO')),
  empresa_id VARCHAR(50) NOT NULL REFERENCES empresas(id),
  proy_def   TEXT,
  proyectos  TEXT[]
);

CREATE TABLE planilla (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serie       TEXT NOT NULL,
  num         INTEGER NOT NULL,
  fecha       DATE NOT NULL,
  usuario_id  UUID REFERENCES usuarios(id),
  dni         VARCHAR(8) NOT NULL,
  trabajador  TEXT NOT NULL,
  email       TEXT NOT NULL,
  total       NUMERIC(10,2) NOT NULL DEFAULT 0,
  UNIQUE (serie, num)
);

CREATE TABLE planilla_detalle (
  id          BIGSERIAL PRIMARY KEY,
  planilla_id UUID NOT NULL REFERENCES planilla(id) ON DELETE CASCADE,
  proyecto    TEXT,
  destino     TEXT,
  motivo      TEXT,
  pc          TEXT,
  monto       NUMERIC(10,2) NOT NULL DEFAULT 0
);

INSERT INTO empresas (id, razon, ruc, direccion, telefono, logo) VALUES
('INV_PADOVA','INVERSIONES PADOVA S.A.C.','20523824598','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331',''),
('CONS_PADOVA','CONSTRUCTORA PADOVA S.A.C.','20601444341','JR. LAS PONCIANAS 139 OF.201 - LA MOLINA VIEJA','495-1331','');

INSERT INTO usuarios (activo,dni,nombres,apellidos,email,rol,empresa_id,proy_def,proyectos) VALUES
(true,'44895702','YRVING','LEON','admin@empresa.com','ADMIN_PADOVA','INV_PADOVA','ADMIN PADOVA',ARRAY['ADMIN PADOVA','LITORAL 900','SANTA BEATRIZ']),
(true,'44081950','JOEL','GARGATE','usuario@empresa.com','USUARIO','CONS_PADOVA','SANTA BEATRIZ',ARRAY['SANTA BEATRIZ']);

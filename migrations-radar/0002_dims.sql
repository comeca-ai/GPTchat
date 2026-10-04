CREATE TABLE IF NOT EXISTS radar_cnaes (
  codigo TEXT PRIMARY KEY,
  descricao TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS radar_municipios (
  codigo TEXT PRIMARY KEY,
  descricao TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS radar_naturezas (
  codigo TEXT PRIMARY KEY,
  descricao TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS radar_socios (
  build_id TEXT NOT NULL,
  cnpj_raiz TEXT NOT NULL,
  nome_socio TEXT NOT NULL,
  qualificacao TEXT,
  data_entrada TEXT,
  PRIMARY KEY (build_id, cnpj_raiz, nome_socio)
);
CREATE INDEX IF NOT EXISTS idx_radar_socios_raiz ON radar_socios(build_id, cnpj_raiz);

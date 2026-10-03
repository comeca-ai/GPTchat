PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS radar_builds (
  build_id TEXT PRIMARY KEY,
  competencia TEXT NOT NULL,
  uf TEXT NOT NULL,
  regras_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('loading','ready','failed')),
  total_chunks INTEGER NOT NULL DEFAULT 0,
  loaded_chunks INTEGER NOT NULL DEFAULT 0,
  total_registros INTEGER NOT NULL DEFAULT 0,
  quality_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS radar_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_build_id TEXT REFERENCES radar_builds(build_id)
);

CREATE TABLE IF NOT EXISTS radar_estabelecimentos (
  build_id TEXT NOT NULL REFERENCES radar_builds(build_id),
  cnpj TEXT NOT NULL,
  cnpj_raiz TEXT NOT NULL,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT,
  matriz_filial TEXT NOT NULL,
  cnae_principal TEXT NOT NULL,
  cnaes_secundarios TEXT,
  uf TEXT NOT NULL,
  municipio_codigo TEXT,
  porte TEXT,
  natureza_juridica TEXT,
  data_inicio TEXT,
  simples TEXT,
  mei TEXT,
  PRIMARY KEY (build_id, cnpj)
);

CREATE INDEX IF NOT EXISTS idx_radar_estab_raiz ON radar_estabelecimentos(build_id, cnpj_raiz);
CREATE INDEX IF NOT EXISTS idx_radar_estab_cnae ON radar_estabelecimentos(build_id, cnae_principal);

CREATE TABLE IF NOT EXISTS radar_eventos (
  build_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  cnpj TEXT NOT NULL,
  cnpj_raiz TEXT NOT NULL,
  tipo TEXT NOT NULL,
  antes TEXT,
  depois TEXT,
  competencia TEXT NOT NULL,
  PRIMARY KEY (build_id, event_id)
);

CREATE TABLE IF NOT EXISTS radar_carteiras (
  carteira_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  total_cnpjs INTEGER NOT NULL DEFAULT 0,
  invalidos INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS radar_carteira_cnpjs (
  carteira_id TEXT NOT NULL REFERENCES radar_carteiras(carteira_id),
  cnpj TEXT NOT NULL,
  cnpj_raiz TEXT NOT NULL,
  PRIMARY KEY (carteira_id, cnpj)
);

CREATE TABLE IF NOT EXISTS radar_resultados (
  carteira_id TEXT NOT NULL,
  cnpj TEXT NOT NULL,
  encontrado INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL,
  detalhes TEXT NOT NULL,
  build_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  PRIMARY KEY (carteira_id, cnpj)
);

CREATE INDEX IF NOT EXISTS idx_radar_resultados_score
  ON radar_resultados(carteira_id, score DESC, cnpj);

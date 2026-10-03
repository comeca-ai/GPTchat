PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed')),
  company_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
  cnpj_base TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  legal_nature_code TEXT,
  company_size TEXT,
  share_capital_cents INTEGER,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id)
);

CREATE TABLE IF NOT EXISTS establishments (
  cnpj TEXT PRIMARY KEY,
  cnpj_base TEXT NOT NULL REFERENCES companies(cnpj_base),
  trade_name TEXT,
  normalized_trade_name TEXT,
  registration_status INTEGER NOT NULL,
  status_date TEXT,
  main_cnae TEXT,
  city_code TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  opened_at TEXT,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id)
);

CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cnpj_base TEXT NOT NULL REFERENCES companies(cnpj_base),
  partner_name TEXT NOT NULL,
  qualification TEXT,
  joined_at TEXT,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id)
);

CREATE TABLE IF NOT EXISTS simples (
  cnpj_base TEXT PRIMARY KEY REFERENCES companies(cnpj_base),
  simples INTEGER NOT NULL DEFAULT 0,
  mei INTEGER NOT NULL DEFAULT 0,
  simples_since TEXT,
  simples_until TEXT,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id)
);

CREATE TABLE IF NOT EXISTS cnae (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  normalized_description TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(normalized_name);
CREATE INDEX IF NOT EXISTS idx_establishments_geo ON establishments(state, city, registration_status);
CREATE INDEX IF NOT EXISTS idx_establishments_cnae ON establishments(main_cnae, state, city);
CREATE INDEX IF NOT EXISTS idx_establishments_base ON establishments(cnpj_base);
CREATE INDEX IF NOT EXISTS idx_partners_base ON partners(cnpj_base);

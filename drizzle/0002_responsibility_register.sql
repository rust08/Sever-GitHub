CREATE TABLE IF NOT EXISTS responsibility_revisions (
  contract_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  mode TEXT NOT NULL CHECK(mode IN ('simulation','document_review')),
  network_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  pdf_digest TEXT REFERENCES responsibility_documents(digest),
  PRIMARY KEY(contract_id, revision)
);
CREATE TABLE IF NOT EXISTS responsibility_documents (
  digest TEXT PRIMARY KEY,
  content BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS responsibility_assets (
  network_version TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  geometry_json TEXT NOT NULL,
  PRIMARY KEY(network_version,edge_id)
);
CREATE TABLE IF NOT EXISTS responsibility_scope_rows (
  contract_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  line INTEGER NOT NULL,
  edge_id TEXT NOT NULL,
  asset_name TEXT,
  mapped INTEGER NOT NULL CHECK(mapped IN (0,1)),
  operation TEXT NOT NULL,
  customer TEXT NOT NULL,
  executor TEXT NOT NULL,
  officer TEXT NOT NULL,
  source TEXT NOT NULL,
  clause TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_until TEXT NOT NULL,
  object_type TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  owner TEXT NOT NULL,
  balance_holder TEXT NOT NULL,
  PRIMARY KEY(contract_id,revision,line),
  FOREIGN KEY(contract_id,revision) REFERENCES responsibility_revisions(contract_id,revision)
);

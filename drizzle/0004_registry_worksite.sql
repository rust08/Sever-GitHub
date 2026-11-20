CREATE TABLE IF NOT EXISTS responsibility_worksites (
  contract_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  line INTEGER NOT NULL,
  limits_json TEXT NOT NULL,
  PRIMARY KEY(contract_id, revision, line),
  FOREIGN KEY(contract_id, revision, line) REFERENCES responsibility_scope_rows(contract_id, revision, line)
);

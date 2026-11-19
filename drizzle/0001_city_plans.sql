CREATE TABLE IF NOT EXISTS city_plans (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  network_version TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  shift_date TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS city_plans_by_version ON city_plans(network_version,seq);

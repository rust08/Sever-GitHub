CREATE TABLE IF NOT EXISTS networks (id TEXT PRIMARY KEY, source TEXT NOT NULL, depot TEXT NOT NULL, nodes TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS roads (id TEXT PRIMARY KEY, network_id TEXT NOT NULL REFERENCES networks(id), from_node TEXT NOT NULL, to_node TEXT NOT NULL, km REAL NOT NULL CHECK(km>0), payload TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS passes (id TEXT PRIMARY KEY, edge_id TEXT NOT NULL REFERENCES roads(id), payload TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vehicles (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS plans (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, shift_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, input_json TEXT NOT NULL, result_json TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plans_by_shift ON plans(shift_date,seq);

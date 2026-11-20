CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES city_plans(id),
  snapshot_json TEXT NOT NULL,
  creation_key TEXT UNIQUE NOT NULL,
  creation_request TEXT NOT NULL,
  task_key TEXT UNIQUE NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS work_order_events (
  order_id TEXT NOT NULL REFERENCES work_orders(id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  comment TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  PRIMARY KEY(order_id,sequence),
  UNIQUE(order_id,request_key)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS work_order_reviews (
  order_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY(order_id,sequence),
  FOREIGN KEY(order_id,sequence) REFERENCES work_order_events(order_id,sequence)
);

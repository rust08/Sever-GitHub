CREATE TABLE IF NOT EXISTS demo_shift_revisions (
  shift_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  scenario TEXT NOT NULL,
  input_json TEXT NOT NULL,
  event_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  PRIMARY KEY (shift_id,revision)
);

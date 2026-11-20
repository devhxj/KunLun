CREATE TABLE IF NOT EXISTS department_profiles (
  department_id TEXT PRIMARY KEY NOT NULL REFERENCES departments(department_id) ON DELETE CASCADE,
  sort_order INTEGER,
  details_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

UPDATE _schema_version SET version = 27;

CREATE TABLE IF NOT EXISTS departments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL UNIQUE,
  parent_id     TEXT REFERENCES departments(department_id),
  name          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments(parent_id);

UPDATE _schema_version SET version = 26;

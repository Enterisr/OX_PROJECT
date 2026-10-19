BEGIN;

CREATE TABLE IF NOT EXISTS scans (
  id uuid PRIMARY KEY,
  repository_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage text NOT NULL DEFAULT 'Queued',
  error text
);

CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scans(id),
  content jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_scan_id_idx ON findings(scan_id);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scans(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  engine text NOT NULL,
  content jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_scan_id_idx ON reports(scan_id);

COMMIT;

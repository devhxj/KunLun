ALTER TABLE amoeba_metrics ADD COLUMN agg TEXT NOT NULL DEFAULT 'sum';

UPDATE amoeba_metrics SET agg = 'last'
WHERE builtin = 1 AND metric_key IN ('guns', 'chgguns', 'invcost', 'deadsku');

UPDATE _schema_version SET version = 29;

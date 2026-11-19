-- Builds hertz.bronze -> hertz.silver -> hertz.gold from the CSVs in
-- /Volumes/hertz/bronze/raw/. Re-runnable. Run in the Databricks SQL Editor.
-- If your catalog isn't `hertz`, find/replace it here and in app.yaml.

CREATE CATALOG IF NOT EXISTS hertz;
CREATE SCHEMA IF NOT EXISTS hertz.bronze;
CREATE SCHEMA IF NOT EXISTS hertz.silver;
CREATE SCHEMA IF NOT EXISTS hertz.gold;
CREATE VOLUME IF NOT EXISTS hertz.bronze.raw;

-- =====================================================================
-- BRONZE: raw files as-is, every column a string, plus lineage columns
-- =====================================================================
CREATE OR REPLACE TABLE hertz.bronze.job_types AS
SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM read_files('/Volumes/hertz/bronze/raw/job_types.csv',
  format => 'csv', header => true, inferColumnTypes => false);

CREATE OR REPLACE TABLE hertz.bronze.rental_demand AS
SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM read_files('/Volumes/hertz/bronze/raw/rental_demand.csv',
  format => 'csv', header => true, inferColumnTypes => false);

CREATE OR REPLACE TABLE hertz.bronze.vehicle_classes AS
SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM read_files('/Volumes/hertz/bronze/raw/vehicle_classes.csv',
  format => 'csv', header => true, inferColumnTypes => false);

CREATE OR REPLACE TABLE hertz.bronze.work_orders AS
SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM read_files('/Volumes/hertz/bronze/raw/work_orders.csv',
  format => 'csv', header => true, inferColumnTypes => false);

-- =====================================================================
-- SILVER: typed, trimmed, canonical names, deduplicated
-- =====================================================================
CREATE OR REPLACE TABLE hertz.silver.job_types AS
SELECT trim(job_type)                 AS job_type,
       CAST(shop_hours   AS DOUBLE)   AS shop_hours,    -- NULL for vendor-only jobs
       CAST(parts_cost   AS DOUBLE)   AS parts_cost,
       upper(trim(in_house)) = 'Y'    AS in_house,
       CAST(vendor_price AS DOUBLE)   AS vendor_price,
       CAST(vendor_days  AS INT)      AS vendor_days
FROM hertz.bronze.job_types;

CREATE OR REPLACE TABLE hertz.silver.vehicle_classes AS
SELECT trim(vehicle_class) AS vehicle_class,
       CAST(daily_rate AS DOUBLE) AS daily_rate
FROM hertz.bronze.vehicle_classes;

CREATE OR REPLACE TABLE hertz.silver.rental_demand AS
SELECT CAST(date AS DATE)         AS date,
       trim(vehicle_class)        AS vehicle_class,
       CAST(reservations AS INT)  AS reservations,
       CAST(cars_ready   AS INT)  AS cars_ready
FROM hertz.bronze.rental_demand;

-- Cleaning rules:
--   1. job_type mapped to the canonical name in job_types ('battery' -> 'Battery').
--   2. One row per (vehicle, job, opened_ts). This drops exact duplicates
--      (WO-054, WO-024, WO-007) and, where the same job exists as both Open and
--      Closed (WO-015/060, WO-031/059, WO-008/061, WO-058/062), keeps Closed.
CREATE OR REPLACE TABLE hertz.silver.work_orders AS
SELECT trim(w.work_order_id)                               AS work_order_id,
       trim(w.vehicle_id)                                  AS vehicle_id,
       trim(w.vehicle_class)                               AS vehicle_class,
       jt.job_type                                         AS job_type,
       to_timestamp(trim(w.opened_ts), 'yyyy-MM-dd HH:mm') AS opened_ts,
       initcap(trim(w.status))                             AS status
FROM hertz.bronze.work_orders w
JOIN hertz.silver.job_types jt
  ON lower(trim(w.job_type)) = lower(jt.job_type)
QUALIFY row_number() OVER (
  PARTITION BY trim(w.vehicle_id), jt.job_type, trim(w.opened_ts)
  ORDER BY CASE WHEN initcap(trim(w.status)) = 'Closed' THEN 0 ELSE 1 END,
           trim(w.work_order_id)
) = 1;

-- =====================================================================
-- GOLD: business-ready tables the app reads
-- =====================================================================
CREATE OR REPLACE TABLE hertz.gold.fleet_shortfall AS
SELECT d.date,
       d.vehicle_class,
       d.reservations,
       d.cars_ready,
       greatest(d.reservations - d.cars_ready, 0)                AS shortfall,
       greatest(d.reservations - d.cars_ready, 0) * c.daily_rate AS lost_revenue
FROM hertz.silver.rental_demand d
JOIN hertz.silver.vehicle_classes c USING (vehicle_class);

CREATE OR REPLACE TABLE hertz.gold.repair_backlog AS
SELECT w.work_order_id,
       w.vehicle_id,
       w.vehicle_class,
       w.job_type,
       w.opened_ts,
       jt.in_house,
       jt.shop_hours,
       jt.parts_cost,
       jt.vendor_price,
       jt.vendor_days,
       c.daily_rate
FROM hertz.silver.work_orders w
JOIN hertz.silver.job_types jt USING (job_type)
JOIN hertz.silver.vehicle_classes c USING (vehicle_class)
WHERE lower(w.status) = 'open';

-- =====================================================================
-- Sanity checks
-- =====================================================================
SELECT 'bronze.work_orders' AS t, count(*) AS n FROM hertz.bronze.work_orders
UNION ALL SELECT 'silver.work_orders',   count(*) FROM hertz.silver.work_orders
UNION ALL SELECT 'gold.repair_backlog',  count(*) FROM hertz.gold.repair_backlog
UNION ALL SELECT 'gold.fleet_shortfall', count(*) FROM hertz.gold.fleet_shortfall;

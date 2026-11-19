-- Let the Databricks App read and save plans in Lakebase.
-- Run in the Lakebase SQL Editor AFTER planner_schema.sql.
-- The role name is the app service principal's client ID
-- (hertz-technical-challenge -> 58d1a1c0-5e11-4fe1-ab0c-cc08f3198dd0).

GRANT USAGE ON SCHEMA planner TO "58d1a1c0-5e11-4fe1-ab0c-cc08f3198dd0";

-- The current plan is replaced on every save (delete + insert).
GRANT SELECT, INSERT, DELETE ON planner.plan_jobs TO "58d1a1c0-5e11-4fe1-ab0c-cc08f3198dd0";

-- The decision log is append-only: the app can add and read rows,
-- but has no UPDATE or DELETE, so the history can't be changed.
GRANT SELECT, INSERT ON planner.decisions TO "58d1a1c0-5e11-4fe1-ab0c-cc08f3198dd0";

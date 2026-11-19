-- Lakebase (Postgres) tables that store the manager's decisions.
-- Project: hertz-planner · Branch: production · Database: databricks_postgres
-- Safe to re-run: every statement uses IF NOT EXISTS.

CREATE SCHEMA IF NOT EXISTS planner;

-- The current plan: one row per open job for a planning week.
-- `position` is the job's place in the shop queue. Vendor and hold jobs keep
-- their position, so bringing a job back to the shop returns it to where it was.
CREATE TABLE IF NOT EXISTS planner.plan_jobs (
    week_start     date        NOT NULL,
    work_order_id  text        NOT NULL,
    position       integer     NOT NULL,
    assignment     text        NOT NULL CHECK (assignment IN ('shop', 'vendor', 'hold')),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     text,
    PRIMARY KEY (week_start, work_order_id)
);

-- Every decision the manager makes, in order. Never updated or deleted.
CREATE TABLE IF NOT EXISTS planner.decisions (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    week_start        date        NOT NULL,
    made_at           timestamptz NOT NULL DEFAULT now(),
    made_by           text,                  -- manager's email, or 'system'
    action            text        NOT NULL CHECK (action IN
                          -- manager decisions
                          ('move', 'send_to_vendor', 'bring_to_shop', 'hold',
                           'use_suggested', 'reset_to_oldest_first',
                          -- system events
                           'start_plan',      -- first plan for the week, oldest first
                           'job_added',       -- new open work order appeared
                           'job_removed')),   -- work order no longer open
    work_order_id     text,                  -- NULL for whole-plan actions
    detail            jsonb,                 -- e.g. {"from": 7, "to": 3}
    week_cost_before  numeric(12, 2),
    week_cost_after   numeric(12, 2)
);

CREATE INDEX IF NOT EXISTS decisions_week_made_at
    ON planner.decisions (week_start, made_at DESC);

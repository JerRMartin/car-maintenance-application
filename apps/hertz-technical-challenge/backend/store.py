"""Save and load the manager's plan and decisions in Lakebase (Postgres).

Tables are created by sql/planner_schema.sql:
  planner.plan_jobs  - current plan: one row per open job per week
  planner.decisions  - append-only log of every decision

Connection settings come from environment variables. When a Lakebase database
is attached to the Databricks App as a resource, these are set automatically;
for local development, export them yourself:
  PGHOST      e.g. ep-....database.us-east-2.cloud.databricks.com
  PGDATABASE  default: databricks_postgres
  PGUSER      the Postgres role: your email locally, the app's service principal in the app
  PGPORT      default: 5432
The password is a short-lived Databricks OAuth token, fetched fresh per connection.
"""
import json
import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date

import psycopg
from databricks.sdk.core import Config

Assignment = str  # 'shop' | 'vendor' | 'hold'


@dataclass
class PlanJob:
    work_order_id: str
    position: int
    assignment: Assignment


@dataclass
class Decision:
    action: str
    made_by: str
    work_order_id: str | None = None
    detail: dict | None = None
    week_cost_before: float | None = None
    week_cost_after: float | None = None


def _token() -> str:
    # Works for both a local CLI login and the app's service principal.
    header = Config().authenticate()["Authorization"]
    return header.removeprefix("Bearer ")


@contextmanager
def _connect():
    with psycopg.connect(
        host=os.environ["PGHOST"],
        dbname=os.environ.get("PGDATABASE", "databricks_postgres"),
        user=os.environ["PGUSER"],
        port=int(os.environ.get("PGPORT", "5432")),
        password=_token(),
        sslmode="require",
    ) as conn:
        yield conn


def load_plan(week_start: date) -> list[PlanJob]:
    """The saved plan for a week, in queue order. Empty list if none saved yet."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT work_order_id, position, assignment
               FROM planner.plan_jobs WHERE week_start = %s ORDER BY position""",
            (week_start,),
        ).fetchall()
    return [PlanJob(*r) for r in rows]


def save(week_start: date, plan: list[PlanJob], decisions: list[Decision]) -> None:
    """Replace the week's plan and log the decision(s) in one transaction.

    Either everything is saved or nothing is. An advisory lock on the week makes
    two managers' clicks run one after the other instead of overwriting each other.
    """
    with _connect() as conn, conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"plan:{week_start}",))
        conn.execute("DELETE FROM planner.plan_jobs WHERE week_start = %s", (week_start,))
        made_by = decisions[-1].made_by if decisions else None
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO planner.plan_jobs
                     (week_start, work_order_id, position, assignment, updated_by)
                   VALUES (%s, %s, %s, %s, %s)""",
                [(week_start, j.work_order_id, j.position, j.assignment, made_by) for j in plan],
            )
            cur.executemany(
                """INSERT INTO planner.decisions
                     (week_start, made_by, action, work_order_id, detail,
                      week_cost_before, week_cost_after)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                [(week_start, d.made_by, d.action, d.work_order_id,
                  json.dumps(d.detail) if d.detail is not None else None,
                  d.week_cost_before, d.week_cost_after) for d in decisions],
            )


def recent_decisions(week_start: date, limit: int = 50) -> list[dict]:
    """Newest first, for the app's decision log panel."""
    with _connect() as conn:
        cur = conn.execute(
            """SELECT id, made_at, made_by, action, work_order_id, detail,
                      week_cost_before, week_cost_after
               FROM planner.decisions WHERE week_start = %s
               ORDER BY made_at DESC, id DESC LIMIT %s""",
            (week_start, limit),
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

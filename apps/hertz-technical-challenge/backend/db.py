"""Query Unity Catalog tables through the SQL warehouse attached to this app.

Auth is automatic:
  * In Databricks Apps, Config() picks up the app's service principal credentials.
  * Locally, Config() uses your Databricks CLI profile / DATABRICKS_* env vars.

Required env vars (set in app.yaml):
  DATABRICKS_WAREHOUSE_ID  - injected from the app's `sql-warehouse` resource
  HERTZ_CATALOG            - catalog holding the bronze/silver/gold schemas
"""
import logging
import os
from functools import lru_cache

from databricks import sql
from databricks.sdk.core import Config

logger = logging.getLogger(__name__)

CATALOG = os.environ.get("HERTZ_CATALOG", "hertz")


@lru_cache(maxsize=1)
def _config() -> Config:
    return Config()


def query(statement: str, params: dict | None = None) -> list[dict]:
    """Run a SQL statement and return rows as a list of dicts."""
    warehouse_id = os.environ.get("DATABRICKS_WAREHOUSE_ID")
    if not warehouse_id:
        raise RuntimeError(
            "DATABRICKS_WAREHOUSE_ID is not set. Attach a SQL warehouse resource "
            "with key 'sql-warehouse' to the app (or export it locally)."
        )
    cfg = _config()
    with sql.connect(
        server_hostname=cfg.host,
        http_path=f"/sql/1.0/warehouses/{warehouse_id}",
        credentials_provider=lambda: cfg.authenticate,
    ) as conn, conn.cursor() as cur:
        cur.execute(statement, params or {})
        columns = [c[0] for c in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]

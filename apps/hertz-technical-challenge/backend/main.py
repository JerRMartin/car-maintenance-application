# --- diagnostics bootstrap: install crash/exception logging before app code ---
import os as _diag_os
import sys as _diag_sys

_diag_dir = _diag_os.path.dirname(_diag_os.path.abspath(__file__))
if _diag_dir not in _diag_sys.path:
    _diag_sys.path.insert(0, _diag_dir)
import app_diagnostics  # noqa: E402

app_diagnostics.install_diagnostics()
# --- end diagnostics bootstrap ---

import os
import logging
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

# --- Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Fleet Maintenance Planner")


# --- API Routes ---
# Plain `def` (not async): warehouse and Postgres calls block, so FastAPI runs
# these in worker threads instead of stalling the event loop.

class DecisionIn(BaseModel):
    action: str
    work_order_id: str | None = None
    to_position: int | None = None


def _user(request: Request) -> str:
    # Databricks Apps passes the signed-in user's email in this header.
    return request.headers.get("X-Forwarded-Email") or "local-dev"


@app.get("/api/health")
def health_check():
    return {"status": "healthy"}


@app.get("/api/week")
def get_week():
    """The saved plan's week: shop queue, vendor, shortages, costs, previews, log."""
    from backend import service
    try:
        return service.get_week()
    except Exception as exc:
        logger.exception("Failed to build the week")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/decisions")
def post_decision(body: DecisionIn, request: Request):
    """Save one manager decision, then return the updated week."""
    from backend import service
    try:
        return service.decide(body.action, _user(request), body.work_order_id, body.to_position)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Failed to save decision %s", body)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/config")
def get_config():
    """Planning assumptions, so the UI can show what the numbers are based on."""
    from backend.config import load_config

    return load_config().model_dump(mode="json")


@app.get("/api/db-health")
def db_health():
    """Checks both data connections: the SQL warehouse and Lakebase."""
    from backend.db import CATALOG, query
    result = {"catalog": CATALOG}
    try:
        result["warehouse"] = [list(r.values())[0] for r in query(f"SHOW SCHEMAS IN {CATALOG}")]
    except Exception as exc:
        logger.exception("Warehouse health check failed")
        result["warehouse_error"] = str(exc)
    if os.environ.get("PGHOST"):
        try:
            from backend import store
            from backend.config import load_config
            result["lakebase_plan_rows"] = len(store.load_plan(load_config().planning_week.start))
        except Exception as exc:
            logger.exception("Lakebase health check failed")
            result["lakebase_error"] = str(exc)
    else:
        result["lakebase_error"] = "PGHOST not set: no Lakebase resource attached (using in-memory store)"
    result["pg_env"] = {k: os.environ.get(k) for k in ("PGHOST", "PGDATABASE", "PGUSER", "PGPORT")}
    return result


# --- Static Files Setup ---
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
os.makedirs(static_dir, exist_ok=True)

app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

# --- Catch-all for React Routes ---
@app.get("/{full_path:path}")
async def serve_react(full_path: str):
    index_html = os.path.join(static_dir, "index.html")
    if os.path.exists(index_html):
        logger.info(f"Serving React frontend for path: /{full_path}")
        return FileResponse(index_html)
    logger.error("Frontend not built. index.html missing.")
    raise HTTPException(
        status_code=404,
        detail="Frontend not built. Please run 'npm run build' first."
    )
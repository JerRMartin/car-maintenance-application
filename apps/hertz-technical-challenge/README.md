# Fleet maintenance planner (Databricks App)

See the [repository README](../../README.md) for what the app does, how to install and run it,
and what was cleaned in the data.

Quick local run:

```bash
pip install -r requirements.txt
npm install && npm run build
export DATABRICKS_CONFIG_PROFILE=<profile> DATABRICKS_WAREHOUSE_ID=<warehouse id>
uvicorn backend.main:app --reload --port 8000
```

Tests: `python -m unittest tests.test_planner -v`

# Shop or Vendor? Fleet maintenance planner

A Databricks App (FastAPI + React) that helps a fleet maintenance manager decide which cars the
shop fixes first and which go to the outside vendor. The app is in
`apps/hertz-technical-challenge/`; data cleaning is in `notebooks/fleet_planning.ipynb`; the raw
input files are in `data/`.

---

## How to install and run the app

### On Databricks

1. **Load the data.** Create the catalog and a volume, then upload the four files in `data/` to
   the volume:
   ```sql
   CREATE CATALOG IF NOT EXISTS hertz;
   CREATE SCHEMA IF NOT EXISTS hertz.bronze;
   CREATE SCHEMA IF NOT EXISTS hertz.silver;
   CREATE VOLUME IF NOT EXISTS hertz.bronze.raw;   -- upload data/*.csv here
   ```
   Then run the **Bronze** and **Silver** cells of `notebooks/fleet_planning.ipynb` (in
   Databricks, or from VS Code with Databricks Connect). This builds the raw `hertz.bronze.*` and
   cleaned `hertz.silver.*` tables and runs data-quality checks.
2. **Create the decision store.** Create a Lakebase Postgres project (e.g. `hertz-planner`) and
   run `apps/hertz-technical-challenge/sql/planner_schema.sql` in its SQL editor.
3. **Create the app** from this Git repo with source path `apps/hertz-technical-challenge`, and
   add these resources in *Settings → Resources*:

   | Resource | Key | Permission |
   |---|---|---|
   | SQL warehouse | `sql-warehouse` | Can use |
   | Lakebase database (the project above) | `database` | Can connect and create |
   | Genie space (optional, for the chat panel) | `genie-space` | Can run |

4. **Grant the app's service principal access** (its ID is on the app's Authorization page). In
   the Databricks SQL editor:
   ```sql
   GRANT USE CATALOG ON CATALOG hertz TO `<app-service-principal-id>`;
   GRANT USE SCHEMA, SELECT ON SCHEMA hertz.silver TO `<app-service-principal-id>`;
   ```
   In the Lakebase SQL editor, run `apps/hertz-technical-challenge/sql/planner_grants.sql` with
   the role name changed to the app's service principal ID.
5. **Deploy** the app (resources are passed to the app at deploy time) and open its URL.

Optional chat panel: create a Genie space over the four `hertz.silver` tables, paste
`apps/hertz-technical-challenge/genie/instructions.md` into its instructions, attach it as above
and redeploy.

### Locally

Requirements: Python 3.12, Node 18+, and a Databricks CLI login (`databricks auth login`) to a
workspace with the `hertz.silver` tables from step 1.

```bash
cd apps/hertz-technical-challenge
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
npm install && npm run build                            # builds the frontend into backend/static

export DATABRICKS_CONFIG_PROFILE=<your profile>
export DATABRICKS_WAREHOUSE_ID=<SQL warehouse id>
uvicorn backend.main:app --reload --port 8000           # open http://localhost:8000
```

- Without Lakebase settings (`PGHOST`, `PGUSER`, `PGDATABASE`) the app keeps decisions in memory
  and shows a "not being saved" banner. Set `GENIE_SPACE_ID` to enable the chat panel.
- For frontend hot reload, also run `npm run dev` and open http://localhost:5173.

**Tests** (no Databricks needed; they use a snapshot of the cleaned tables):

```bash
cd apps/hertz-technical-challenge
python -m unittest tests.test_planner -v
```

### Configuration

The rules from the brief are in `apps/hertz-technical-challenge/config/planning.yaml`, so they
can be changed without editing code: technician hours per day (12), shop days (Mon–Fri), labor
rate ($68/hour), ready delay (next morning), planning week (Mon 10/12 – Sun 10/18), vendor
dispatch days, and the weekly vendor budget ($14,000).

---

## What I cleaned in the data

The raw files are kept unchanged in `data/` and in the `hertz.bronze` tables. Cleaning happens
between bronze and silver in `notebooks/fleet_planning.ipynb`.

| Issue | Rows affected | What I did |
|---|---|---|
| **Exact duplicate rows** in `work_orders.csv` | WO-054, WO-024, WO-007 (one extra copy each) | Dropped the duplicates (65 → 62 rows). |
| **Same job both Open and Closed**: same vehicle, job type and `opened_ts` under two work order IDs | WO-015 / WO-060, WO-031 / WO-059, WO-008 / WO-061, WO-058 / WO-062 | Treated *Closed* as the newer record and dropped the stale *Open* row (62 → 58 rows: **54 open**, 4 closed). |
| **Inconsistent capitalization** (e.g. `battery`, `oil change`, `Oil Change`) | Several `job_type` values | Trimmed and lowercased `vehicle_class`, `job_type` and `status` in every table, so joins match. |
| **Closed orders** | 4 | Kept in silver for history; planning uses **open** work orders only. |
| **Types** | All tables | Cast explicitly: dates, timestamps (`yyyy-MM-dd HH:mm`), numbers, and `in_house` Y/N → boolean. Vendor-only job types have no shop hours or parts cost (NULL). |

The cleaning step ends with data-quality checks (unique work order IDs, every job type and class
found in the lookup tables, no failed date casts, in-house job types fully costed) and stops if
any of them fail.

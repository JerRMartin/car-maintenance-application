# Shop or Vendor? Fleet maintenance planner

A Databricks App that helps a fleet maintenance manager decide, every day, **which cars the shop
fixes first** and **which cars go to the outside vendor**, and shows what each decision does to
the cost of the week (shop + vendor + lost revenue) and the vendor budget left.

- **Show the week**: shop queue in order with each car's ready-to-rent day (list and by-day
  views), cars short per class per day, and the cost of the week.
- **Prioritize**: *Optimize: Savings* (default) or *Optimize: Car readiness* suggests a better
  plan from the rental demand; the manager can reorder by drag and drop, ▲▼ or position number.
- **Outsource**: send any job to the vendor or bring it back to the shop; choose which
  vendor-only jobs go out this week. Every choice shows its effect on cost and budget.
- **Every decision is saved** (Lakebase Postgres) with who made it and the cost before/after,
  then the queue, shortages and cost are recomputed.
- **Extra feature: Ask Genie**, a chat panel for ad-hoc questions about the fleet data
  (see [why](#extra-feature-ask-genie)).

---

## Repository layout

```
data/                         Raw input CSVs exactly as provided (duplicates and all)
notebooks/fleet_planning.ipynb  Data cleaning (bronze → silver), baseline, and the analysis
                                behind the recommendations
apps/hertz-technical-challenge/   The Databricks App
  app.yaml                    App entry point and resource bindings
  config/planning.yaml        Manager-editable rules (hours, labor rate, budget, week, …)
  backend/                    FastAPI: planner.py (simulation + optimizers), service.py,
                              store.py (Lakebase), db.py (SQL warehouse), genie.py, main.py
  frontend/                   React + TypeScript (Vite)
  sql/planner_schema.sql      Lakebase tables for the plan and the decision log
  sql/planner_grants.sql      Lakebase grants for the app's service principal
  genie/instructions.md       Instructions for the Genie space
  tests/test_planner.py       Planner tests (reproduce the notebook's numbers)
```

---

## How to run it

### On Databricks (as deployed)

1. **Load the data**
   - Create the catalog and a volume, then upload the four files in `data/` to it:
     ```sql
     CREATE CATALOG IF NOT EXISTS hertz;
     CREATE SCHEMA IF NOT EXISTS hertz.bronze;
     CREATE SCHEMA IF NOT EXISTS hertz.silver;
     CREATE VOLUME IF NOT EXISTS hertz.bronze.raw;   -- upload data/*.csv here
     ```
   - Run the **Bronze** and **Silver** cells of `notebooks/fleet_planning.ipynb` (in Databricks,
     or from VS Code with Databricks Connect). This builds `hertz.bronze.*` (raw) and
     `hertz.silver.*` (cleaned) tables and runs data-quality checks.
2. **Create the decision store**: create a Lakebase Postgres project (e.g. `hertz-planner`) and
   run `apps/hertz-technical-challenge/sql/planner_schema.sql` in its SQL editor.
3. **Create the app** from this Git repo (source path `apps/hertz-technical-challenge`) and add
   resources in *Settings → Resources*:

   | Resource | Key | Permission |
   |---|---|---|
   | SQL warehouse | `sql-warehouse` | Can use |
   | Lakebase database (the project above) | `database` | Can connect and create |
   | Genie space (optional, for the chat) | `genie-space` | Can run |

4. **Grant the app's service principal access** (its ID is on the app's Authorization page):
   ```sql
   -- Databricks SQL editor
   GRANT USE CATALOG ON CATALOG hertz TO `<app-service-principal-id>`;
   GRANT USE SCHEMA, SELECT ON SCHEMA hertz.silver TO `<app-service-principal-id>`;
   ```
   and in the Lakebase SQL editor run `sql/planner_grants.sql` (edit the role name).
5. **Deploy** (resources reach the app at deploy time). The first time the page opens, the
   week starts as today's practice: oldest first, vendor-only jobs not yet sent.

Optional Genie space: create a space over the four `hertz.silver` tables, paste
`genie/instructions.md` into its instructions, and attach it as above.

### Locally

Requirements: Python 3.12, Node 18+, and a Databricks CLI login (`databricks auth login`).

```bash
cd apps/hertz-technical-challenge
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
npm install && npm run build                            # builds the frontend into backend/static

export DATABRICKS_CONFIG_PROFILE=<your profile>
export DATABRICKS_WAREHOUSE_ID=<warehouse id>           # reads the hertz.silver tables
# optional: PGHOST / PGUSER / PGDATABASE for Lakebase, GENIE_SPACE_ID for the chat
uvicorn backend.main:app --reload --port 8000           # http://localhost:8000
```

Without the `PG*` variables the app keeps decisions **in memory** and shows a "not being saved"
banner, which is handy for local development. For frontend hot reload, run `npm run dev` and open
http://localhost:5173 (it proxies `/api` to port 8000).

**Tests** (no Databricks needed; they use a snapshot of the silver tables):
```bash
cd apps/hertz-technical-challenge
python -m unittest tests.test_planner -v
```

### Configuration

`apps/hertz-technical-challenge/config/planning.yaml` holds the rules from the brief so a manager
can change them without editing code: technician hours per day (12), open days (Mon–Fri), labor
rate ($68/h), ready delay (next morning), planning week (Mon 10/12 – Sun 10/18), vendor dispatch
days, and the weekly vendor budget ($14,000). Values are validated on load.

---

## What I cleaned in the data

Raw files are kept unchanged in `data/` and in the `hertz.bronze` tables; cleaning happens
between bronze and silver in `notebooks/fleet_planning.ipynb`.

| Issue | Rows affected | What I did |
|---|---|---|
| **Exact duplicate rows** in `work_orders.csv` | WO-054, WO-024, WO-007 (one extra copy each) | Dropped the duplicates (65 → 62 rows). |
| **Same job both Open and Closed**: same vehicle, job type and `opened_ts` under two work order IDs | WO-015 / WO-060, WO-031 / WO-059, WO-008 / WO-061, WO-058 / WO-062 | Treated *Closed* as the newer truth and dropped the stale *Open* row (62 → 58 rows: **54 open**, 4 closed). |
| **Inconsistent capitalization** (e.g. `battery`, `oil change`, `Oil Change`) | Several `job_type` values | Trimmed and lowercased `vehicle_class`, `job_type` and `status` in every table, so joins match. |
| **Closed orders** | 4 | Kept in silver for history; planning uses **open** work orders only. |
| **Types** | All tables | Cast explicitly: dates, timestamps (`yyyy-MM-dd HH:mm`), numbers, and `in_house` Y/N → boolean. Vendor-only job types have no shop hours or parts cost (NULL). |

The notebook ends the cleaning with data-quality checks (unique work order IDs, every job type
and class found in the lookup tables, no failed date casts, in-house job types fully costed) and
stops if any fail.

---

## How the numbers are computed

Rules come straight from the brief; where it is silent, these are my interpretations:

- **Shop**: works its queue in order, 12 technician hours per open day. A car finished on a day
  is ready the next morning. A job can carry over to the next open day. **Parts are charged when
  a job starts** (they're bought before the work), even if it finishes after the week.
- **Vendor**: jobs are sent on the first day of the week and are ready after `vendor_days`
  (sending as early as possible is always best with a fixed week: same price, car back sooner).
  `in_house = N` jobs can only go to the vendor; the manager chooses whether they go **this
  week** or next week (the brief says *where* they go, not *when*). They start unsent.
- **Shortage**, counted separately for each day and class:
  `short = max(0, reservations − cars_ready − cars back from maintenance by that morning)`.
  Reservations are read as cars needed **on rent that day** (they include multi-day rentals that
  started earlier), so rented cars aren't subtracted again the next day.
- **Lost revenue** = short cars × daily rate. **Cost of the week** = shop + vendor + lost revenue
  for Monday–Sunday.

### The optimizers (both re-plan the week day by day)

- **Savings** (lowest cost of the week): builds the shop order one job at a time, moving forward
  through the week, always starting the job worth the most per shop hour, where
  *value = daily rate × days its class would still be short once the car is back*. It then sends a
  job to the vendor only if re-planning shows the week's cost goes down.
- **Car readiness** (fewest car-days short within the budget): works out the cars each short
  class needs by the first short morning, uses a **0/1 knapsack** over the first day's shop hours
  to keep the jobs most expensive to outsource (and any the vendor can't return in time), sends the
  rest to the vendor, then trims to the budget and tries swaps for a cheaper plan with no more cars
  short.

Both keep the manager's choice of which vendor-only jobs go out this week.

---

## Results for this week

Cost of the week = shop + vendor + lost revenue (Mon 10/12 – Sun 10/18). Car-days short = sum of
cars short over the week.

| Plan | Cost of the week | Car-days short |
|---|---|---|
| **Oldest first** (today's practice; vendor-only jobs sent this week) | **$29,821** | 97 |
| **Optimize: Savings**, vendor-only jobs this week | **$23,742** (−$6,079, −20%) | 28 |
| Optimize: Savings, vendor-only jobs next week | $14,962 (+$8,780 moves to next week) | 28 |
| Optimize: Car readiness, vendor-only jobs this week | $27,818 | 9 |
| Optimize: Car readiness, vendor-only jobs next week | $20,852 (+$8,780 next week) | **6** (the minimum possible) |

- **Ordering the queue day by day is worth about $6,100 (−20%) at no extra cost**, by putting
  short classes first and quick, high-value repairs on Monday. Classes with spare cars (Economy,
  Full-size) wait.
- **Sending in-house jobs to the vendor doesn't lower the week's cost** when the shop is fully
  booked: its hours get used either way, so a send costs close to the full vendor price. The
  vendor is a **service** decision: roughly $215–$270 per customer-day saved, depending on
  whether the vendor-only jobs go this week.
- **SUV can't reach zero**: demand exceeds the whole SUV fleet including every car in repair, so
  one SUV customer a day is unserved under any repair plan. That needs a fleet decision (transfer
  or upgrade), not a maintenance one.
- The three vendor-only jobs are all in classes with spare cars and recover nothing this week;
  moving them to next week frees budget for short-class cars, but delays those cars a week
  (transmissions take 7 days).

---

## Extra feature: Ask Genie

A chat panel (bottom-right) backed by a Databricks Genie space over the silver tables, so a
manager can ask ad-hoc questions ("How many SUVs are out of service right now?", "What would it
cost to send every open SUV repair to the vendor?") without waiting on an analyst. It shows the
answer, a result table and the SQL Genie ran. It reads the data tables, not the plan saved in the
app.

## What I skipped

- **Sending vendor jobs on later days**: all vendor sends happen on the first day of the week;
  with a fixed week that is always best, so per-day send dates weren't modeled.
- **Next week's demand**: not in the data, so "send next week" shows its timing cost (cars back a
  week later) but not its rental impact next week.
- **Undo / plan versions**: the decision log is append-only, and *Reset to oldest first* restarts
  the plan, but there's no one-click undo.
- **Multi-user conflict handling** beyond serializing saves; there's no sign-in beyond the
  Databricks App's own authentication.
- **Genie can't see the saved plan**: that would need the plan copied to a Unity Catalog table.

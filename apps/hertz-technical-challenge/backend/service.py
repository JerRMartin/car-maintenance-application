"""Glue between the API, the planner, and the saved plan.

Every request: load inputs (silver tables, cached) -> load the saved plan ->
simulate -> return the week plus "what if" previews for each job.
Every decision: apply it to the plan -> simulate before/after -> save plan +
decision in one transaction -> return the updated week.
"""
from __future__ import annotations

import logging
import os
import threading
import time

from backend import planner, store
from backend.config import load_config
from backend.planner import HOLD, SHOP, VENDOR, Inputs, PlanItem

logger = logging.getLogger(__name__)

SILVER = f"{os.environ.get('HERTZ_CATALOG', 'hertz')}.silver"
INPUT_TTL_SECONDS = 300           # silver data changes rarely; cache it for 5 minutes

_inputs_cache: tuple[float, Inputs] | None = None
_lock = threading.Lock()


# ---------------------------------------------------------------- inputs ----
def load_inputs(force: bool = False) -> Inputs:
    global _inputs_cache
    with _lock:
        if not force and _inputs_cache and time.time() - _inputs_cache[0] < INPUT_TTL_SECONDS:
            return _inputs_cache[1]
        from backend.db import query
        inputs = planner.build_inputs(
            query(f"SELECT * FROM {SILVER}.work_orders"),
            query(f"SELECT * FROM {SILVER}.job_types"),
            query(f"SELECT * FROM {SILVER}.vehicle_classes"),
            query(f"SELECT * FROM {SILVER}.rental_demand"),
        )
        _inputs_cache = (time.time(), inputs)
        return inputs


# --------------------------------------------------------------- storage ----
class _MemoryStore:
    """Used only when no Lakebase is configured (local development).
    Nothing survives a restart; the UI shows a 'not saved' banner."""

    def __init__(self):
        self.plans: dict = {}
        self.log: dict = {}

    def load_plan(self, week):
        return list(self.plans.get(week, []))

    def save(self, week, plan, decisions):
        self.plans[week] = list(plan)
        for d in decisions:
            self.log.setdefault(week, []).insert(0, {
                "id": len(self.log.get(week, [])) + 1, "made_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "made_by": d.made_by, "action": d.action, "work_order_id": d.work_order_id,
                "detail": d.detail, "week_cost_before": d.week_cost_before,
                "week_cost_after": d.week_cost_after})

    def recent_decisions(self, week, limit=50):
        return self.log.get(week, [])[:limit]


_memory = _MemoryStore()


def _storage():
    return ("lakebase", store) if os.environ.get("PGHOST") else ("memory", _memory)


# ----------------------------------------------------------- plan <-> db ----
def _to_items(saved: list[store.PlanJob]) -> list[PlanItem]:
    return [PlanItem(p.work_order_id, p.assignment) for p in sorted(saved, key=lambda p: p.position)]


def _to_rows(plan: list[PlanItem]) -> list[store.PlanJob]:
    return [store.PlanJob(p.work_order_id, i + 1, p.assignment) for i, p in enumerate(plan)]


def _sync_with_open_jobs(plan: list[PlanItem], inputs: Inputs) -> tuple[list[PlanItem], list[store.Decision]]:
    """Drop jobs that are no longer open; append new open jobs at the end."""
    events = []
    kept = []
    for p in plan:
        if p.work_order_id in inputs.jobs:
            kept.append(p)
        else:
            events.append(store.Decision("job_removed", "system", p.work_order_id))
    planned = {p.work_order_id for p in kept}
    new_jobs = sorted((j for j in inputs.jobs.values() if j.work_order_id not in planned),
                      key=lambda j: (j.opened_ts, j.work_order_id))
    for j in new_jobs:
        kept.append(PlanItem(j.work_order_id, SHOP if j.in_house else HOLD))
        events.append(store.Decision("job_added", "system", j.work_order_id))
    return kept, events


def _current_plan(inputs: Inputs, cfg) -> list[PlanItem]:
    """Saved plan, creating it (oldest first) or syncing it when needed."""
    _, db = _storage()
    week = cfg.planning_week.start
    saved = db.load_plan(week)
    if not saved:
        plan = planner.oldest_first_plan(inputs)
        cost = planner.simulate(plan, inputs, cfg).costs.total
        db.save(week, _to_rows(plan), [store.Decision("start_plan", "system",
                                                      week_cost_after=cost)])
        return plan
    plan, events = _sync_with_open_jobs(_to_items(saved), inputs)
    if events:
        db.save(week, _to_rows(plan), events)
    return plan


# -------------------------------------------------------------- decisions ----
ACTIONS = {"move", "send_to_vendor", "bring_to_shop", "hold", "reset_to_oldest_first"}


def _apply(plan: list[PlanItem], inputs: Inputs, action: str,
           work_order_id: str | None, to_position: int | None) -> tuple[list[PlanItem], dict]:
    if action == "reset_to_oldest_first":
        return planner.oldest_first_plan(inputs), {}

    idx = next((i for i, p in enumerate(plan) if p.work_order_id == work_order_id), None)
    if idx is None:
        raise ValueError(f"{work_order_id} is not in the plan")
    plan = [PlanItem(p.work_order_id, p.assignment) for p in plan]
    item = plan[idx]

    if action == "move":
        if item.assignment != SHOP:
            raise ValueError("Only shop jobs can be moved in the queue")
        shop = [p for p in plan if p.assignment == SHOP]
        frm = shop.index(item) + 1
        to = max(1, min(int(to_position or frm), len(shop)))
        if to == frm:
            return plan, {"from": frm, "to": to}
        plan.pop(idx)
        others = [p for p in plan if p.assignment == SHOP]
        if to > len(others):                      # after the last shop job
            anchor = plan.index(others[-1]) + 1
        else:                                     # before the job now at that spot
            anchor = plan.index(others[to - 1])
        plan.insert(anchor, item)
        return plan, {"from": frm, "to": to}

    target = {"send_to_vendor": VENDOR, "bring_to_shop": SHOP, "hold": HOLD}[action]
    if item.assignment == target:
        raise ValueError(f"{work_order_id} is already assigned to {target}")
    if target == SHOP and not inputs.jobs[work_order_id].in_house:
        raise ValueError(f"{work_order_id} is vendor-only and can't go to the shop")
    detail = {"from": item.assignment, "to": target}
    item.assignment = target
    return plan, detail


def decide(action: str, made_by: str, work_order_id: str | None = None,
           to_position: int | None = None) -> dict:
    if action not in ACTIONS:
        raise ValueError(f"Unknown action {action!r}")
    cfg, inputs = load_config(), load_inputs()
    _, db = _storage()
    with _lock:                                   # one decision at a time in this process
        plan = _current_plan(inputs, cfg)
        before = planner.simulate(plan, inputs, cfg).costs.total
        new_plan, detail = _apply(plan, inputs, action, work_order_id, to_position)
        after = planner.simulate(new_plan, inputs, cfg).costs.total
        db.save(cfg.planning_week.start, _to_rows(new_plan), [store.Decision(
            action, made_by, work_order_id, detail, round(before, 2), round(after, 2))])
    return get_week()


# ------------------------------------------------------------------- view ----
def _previews(plan: list[PlanItem], inputs: Inputs, cfg, current_total: float) -> dict:
    """For each job, what each alternative assignment would do to the week."""
    out = {}
    for i, p in enumerate(plan):
        options = [a for a in (SHOP, VENDOR, HOLD)
                   if a != p.assignment and (a != SHOP or inputs.jobs[p.work_order_id].in_house)]
        out[p.work_order_id] = {}
        for a in options:
            trial = plan[:i] + [PlanItem(p.work_order_id, a)] + plan[i + 1:]
            costs = planner.simulate(trial, inputs, cfg).costs
            out[p.work_order_id][a] = {"total_change": round(costs.total - current_total, 2),
                                       "budget_left": round(costs.budget_left, 2)}
    return out


def get_week() -> dict:
    cfg, inputs = load_config(), load_inputs()
    storage, db = _storage()
    plan = _current_plan(inputs, cfg)
    week = planner.simulate(plan, inputs, cfg)
    baseline = planner.simulate(planner.oldest_first_plan(inputs), inputs, cfg).costs.total
    return {
        "week": week.to_dict(),
        "baseline_total": round(baseline, 2),
        "previews": _previews(plan, inputs, cfg, week.costs.total),
        "jobs": {k: {"vehicle_id": j.vehicle_id, "in_house": j.in_house,
                     "vendor_price": j.vendor_price, "vendor_days": j.vendor_days}
                 for k, j in inputs.jobs.items()},
        "decisions": db.recent_decisions(cfg.planning_week.start),
        "config": cfg.model_dump(mode="json"),
        "storage": storage,
    }

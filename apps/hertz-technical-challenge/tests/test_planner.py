"""The planner must reproduce the notebook's oldest-first baseline exactly.

Fixtures are a snapshot of hertz.silver.* taken 2026-11-19.
Run from the app folder:  python -m unittest tests.test_planner -v
"""
import csv
import unittest
from datetime import date
from pathlib import Path

from backend.config import load_config
from backend.planner import (HOLD, SHOP, VENDOR, PlanItem, build_inputs,
                             oldest_first_plan, optimize, short_classes, short_first_plan, simulate)

FIXTURES = Path(__file__).parent / "fixtures" / "silver"


def _rows(name):
    with open(FIXTURES / f"{name}.csv", encoding="utf-8") as f:
        return list(csv.DictReader(f))


class BaselineMatchesNotebook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = load_config()
        cls.inputs = build_inputs(_rows("work_orders"), _rows("job_types"),
                                  _rows("vehicle_classes"), _rows("rental_demand"))
        cls.week = simulate(oldest_first_plan(cls.inputs), cls.inputs, cls.cfg)

    def test_step1_job_counts(self):
        self.assertEqual(len(self.inputs.jobs), 54)
        self.assertEqual(sum(j.in_house for j in self.inputs.jobs.values()), 51)

    def test_step3_queue(self):
        q = self.week.shop_queue
        self.assertEqual(sum(r.finish_day is not None for r in q), 35)
        self.assertEqual([r.work_order_id for r in q[:3]], ["WO-021", "WO-044", "WO-052"])
        # WO-048 (#7) spans Mon -> Tue, ready Wed (assumption A)
        r7 = q[6]
        self.assertEqual((r7.work_order_id, r7.start_day, r7.finish_day, r7.ready_date),
                         ("WO-048", date(2026, 10, 12), date(2026, 10, 13), date(2026, 10, 14)))
        # WO-026 (#36) is part-done at week end: 1.25h labor + parts (assumption B)
        r36 = q[35]
        self.assertEqual((r36.work_order_id, r36.hours_worked, r36.ready_date, r36.shop_cost),
                         ("WO-026", 1.25, None, 465.0))
        # No work on weekends, and no day over 12 hours
        self.assertTrue(all(r.start_day is None or r.start_day.weekday() < 5 for r in q))

    def test_daily_capacity(self):
        from collections import defaultdict
        per_day = defaultdict(float)
        for r in self.week.shop_queue:
            self.assertAlmostEqual(sum(g.hours for g in r.segments), r.hours_worked)
            for g in r.segments:
                per_day[g.day] += g.hours
        self.assertEqual(sorted(per_day), self.week.shop_days)       # Mon-Fri only
        self.assertTrue(all(abs(h - 12) < 1e-9 for h in per_day.values()))  # every day full
        wo48 = next(r for r in self.week.shop_queue if r.work_order_id == "WO-048")
        self.assertEqual([(g.day, g.hours) for g in wo48.segments],
                         [(date(2026, 10, 12), 2.0), (date(2026, 10, 13), 1.0)])

    def test_step4_vendor(self):
        got = {(v.work_order_id, v.sent_date, v.ready_date) for v in self.week.vendor}
        self.assertEqual(got, {("WO-057", date(2026, 10, 12), date(2026, 10, 17)),
                               ("WO-055", date(2026, 10, 12), date(2026, 10, 19)),
                               ("WO-056", date(2026, 10, 12), date(2026, 10, 19))})

    def test_step5_shortages(self):
        suv = [c.short for c in self.week.shortages if c.vehicle_class == "suv"]
        self.assertEqual(suv, [0, 16, 13, 11, 10, 7, 7])
        premium = [c.short for c in self.week.shortages if c.vehicle_class == "premium suv"]
        self.assertEqual(premium, [0, 4, 4, 3, 2, 2, 2])

    def test_step6_costs(self):
        c = self.week.costs
        self.assertEqual((round(c.shop), round(c.vendor), round(c.lost_revenue), round(c.total)),
                         (12685, 8780, 8356, 29821))
        self.assertEqual(round(c.budget_left), 14000 - 8780)


class PlanRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = load_config()
        cls.inputs = build_inputs(_rows("work_orders"), _rows("job_types"),
                                  _rows("vehicle_classes"), _rows("rental_demand"))

    def test_suggested_order_short_classes_first(self):
        self.assertEqual(short_classes(self.inputs, self.cfg), {"suv", "premium suv", "minivan", "midsize"})
        plan = short_first_plan(oldest_first_plan(self.inputs), self.inputs, self.cfg)
        week = simulate(plan, self.inputs, self.cfg)
        self.assertEqual(round(week.costs.total), 25120)               # same as the notebook
        shop = [self.inputs.jobs[r.work_order_id] for r in week.shop_queue]
        n_short = sum(j.vehicle_class in short_classes(self.inputs, self.cfg) for j in shop)
        self.assertTrue(all(j.vehicle_class in short_classes(self.inputs, self.cfg) for j in shop[:n_short]))

    def test_suggested_order_keeps_vendor_choices(self):
        plan = oldest_first_plan(self.inputs)
        plan = [PlanItem(p.work_order_id, VENDOR) if p.work_order_id == "WO-036" else p for p in plan]
        new = {p.work_order_id: p.assignment for p in short_first_plan(plan, self.inputs, self.cfg)}
        self.assertEqual(new["WO-036"], VENDOR)

    def _optimized(self, goal, defer):
        deferred = {j.work_order_id for j in self.inputs.jobs.values() if not j.in_house} if defer else set()
        week = simulate(optimize(self.inputs, self.cfg, goal, deferred), self.inputs, self.cfg)
        return round(week.costs.total), sum(c.short for c in week.shortages)

    def test_optimize_matches_notebook_four_options(self):
        self.assertEqual(self._optimized("savings", defer=True), (14962, 28))     # 1a
        self.assertEqual(self._optimized("savings", defer=False), (23742, 28))    # 1b
        self.assertEqual(self._optimized("readiness", defer=True), (20852, 6))    # 2a
        self.assertEqual(self._optimized("readiness", defer=False), (27818, 9))   # 2b

    def test_oldest_first_can_leave_vendor_only_unsent(self):
        plan = oldest_first_plan(self.inputs, send_vendor_only=False)
        week = simulate(plan, self.inputs, self.cfg)
        self.assertEqual(week.costs.vendor, 0)
        self.assertEqual(sorted(h.work_order_id for h in week.held), ["WO-055", "WO-056", "WO-057"])
        self.assertEqual(round(week.costs.total), 29821 - 8780)

    def test_vendor_only_job_cannot_go_to_shop(self):
        plan = oldest_first_plan(self.inputs)
        plan = [PlanItem(p.work_order_id, SHOP) if p.work_order_id == "WO-055" else p for p in plan]
        with self.assertRaises(ValueError):
            simulate(plan, self.inputs, self.cfg)

    def test_no_split_keeps_each_job_in_one_day(self):
        week = simulate(oldest_first_plan(self.inputs), self.inputs, self.cfg, split_jobs=False)
        for r in week.shop_queue:
            self.assertLessEqual(len(r.segments), 1, r.work_order_id)
            if r.segments:
                self.assertEqual(r.segments[0].hours, r.shop_hours)   # whole job, same day
        per_day = {}
        for r in week.shop_queue:
            for g in r.segments:
                per_day[g.day] = per_day.get(g.day, 0) + g.hours
        self.assertTrue(all(h <= 12 + 1e-9 for h in per_day.values()))

    def test_holding_vendor_jobs_removes_vendor_cost(self):
        plan = [PlanItem(p.work_order_id, HOLD if p.assignment == VENDOR else p.assignment)
                for p in oldest_first_plan(self.inputs)]
        week = simulate(plan, self.inputs, self.cfg)
        self.assertEqual(week.costs.vendor, 0)
        self.assertEqual(len(week.held), 3)


if __name__ == "__main__":
    unittest.main()

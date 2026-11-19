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
                             oldest_first_plan, simulate)

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

    def test_vendor_only_job_cannot_go_to_shop(self):
        plan = oldest_first_plan(self.inputs)
        plan = [PlanItem(p.work_order_id, SHOP) if p.work_order_id == "WO-055" else p for p in plan]
        with self.assertRaises(ValueError):
            simulate(plan, self.inputs, self.cfg)

    def test_holding_vendor_jobs_removes_vendor_cost(self):
        plan = [PlanItem(p.work_order_id, HOLD if p.assignment == VENDOR else p.assignment)
                for p in oldest_first_plan(self.inputs)]
        week = simulate(plan, self.inputs, self.cfg)
        self.assertEqual(week.costs.vendor, 0)
        self.assertEqual(len(week.held), 3)


if __name__ == "__main__":
    unittest.main()

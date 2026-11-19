"""Simulate a maintenance week for a given plan.

A plan is the list of open jobs in queue order, each assigned to:
  shop   - worked by the in-house shop, in queue order
  vendor - sent to the outside vendor on the first dispatch day
  hold   - not worked this week

Ported from the notebook's baseline cell ("Baseline: oldest first (FIFO)").
Assumptions (also in the notebook):
  A. A shop job can span days; unfinished work carries over to the next open day.
  B. Parts are charged when a shop job starts (they're bought before the work),
     even if the job finishes after the week ends.
  C. Vendor jobs are sent on the week's first vendor dispatch day (Monday).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta

from backend.config import PlanningConfig

EPS = 1e-9
SHOP, VENDOR, HOLD = "shop", "vendor", "hold"


# ---------------------------------------------------------------- inputs ----
@dataclass(frozen=True)
class Job:
    work_order_id: str
    vehicle_id: str
    vehicle_class: str
    job_type: str
    opened_ts: datetime
    in_house: bool
    shop_hours: float | None
    parts_cost: float | None
    vendor_price: float
    vendor_days: int


@dataclass(frozen=True)
class DemandDay:
    date: date
    vehicle_class: str
    reservations: int
    cars_ready: int


@dataclass(frozen=True)
class Inputs:
    jobs: dict[str, Job]               # open jobs by work_order_id
    demand: list[DemandDay]
    daily_rate: dict[str, float]       # vehicle_class -> rate


@dataclass
class PlanItem:
    work_order_id: str
    assignment: str                    # shop | vendor | hold


# --------------------------------------------------------------- outputs ----
@dataclass
class DaySegment:
    day: date
    hours: float                       # shop hours spent on this job that day


@dataclass
class ShopRow:
    position: int                      # place in the shop queue (1 = first)
    work_order_id: str
    vehicle_class: str
    job_type: str
    opened_ts: datetime
    shop_hours: float
    hours_worked: float
    start_day: date | None
    finish_day: date | None
    ready_date: date | None            # None = not ready this week
    shop_cost: float
    segments: list[DaySegment] = field(default_factory=list)   # hours per day


@dataclass
class VendorRow:
    work_order_id: str
    vehicle_class: str
    job_type: str
    in_house: bool                     # False = vendor-only job
    vendor_price: float
    sent_date: date
    ready_date: date


@dataclass
class HoldRow:
    work_order_id: str
    vehicle_class: str
    job_type: str
    in_house: bool


@dataclass
class ShortageCell:
    date: date
    vehicle_class: str
    reservations: int
    cars_ready: int
    cars_back: int
    short: int
    lost_revenue: float


@dataclass
class Costs:
    shop: float
    vendor: float
    lost_revenue: float
    total: float
    vendor_budget: float
    budget_left: float


@dataclass
class Week:
    shop_queue: list[ShopRow]
    vendor: list[VendorRow]
    held: list[HoldRow]
    shortages: list[ShortageCell]
    costs: Costs
    week_days: list[date] = field(default_factory=list)
    shop_days: list[date] = field(default_factory=list)
    hours_per_day: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# ------------------------------------------------------------ simulation ----
def _week_days(cfg: PlanningConfig) -> list[date]:
    start, end = cfg.planning_week.start, cfg.planning_week.end
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def _day_name(d: date) -> str:
    return d.strftime("%a")            # Mon, Tue, ...


def _add_vendor_days(sent: date, n: int, cfg: PlanningConfig) -> date:
    if cfg.vendor.turnaround_counts_weekends:
        return sent + timedelta(days=n)
    d = sent
    while n > 0:                       # count Mon-Fri only
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def validate_plan(plan: list[PlanItem], inputs: Inputs) -> None:
    seen = set()
    for item in plan:
        if item.work_order_id not in inputs.jobs:
            raise ValueError(f"{item.work_order_id} is not an open job")
        if item.work_order_id in seen:
            raise ValueError(f"{item.work_order_id} appears twice in the plan")
        if item.assignment not in (SHOP, VENDOR, HOLD):
            raise ValueError(f"{item.work_order_id}: unknown assignment {item.assignment!r}")
        if item.assignment == SHOP and not inputs.jobs[item.work_order_id].in_house:
            raise ValueError(f"{item.work_order_id} is vendor-only and can't go to the shop")
        seen.add(item.work_order_id)


def simulate(plan: list[PlanItem], inputs: Inputs, cfg: PlanningConfig, split_jobs: bool = True) -> Week:
    """split_jobs=True: a job can carry over to the next day (assumption A).
    split_jobs=False: a job that doesn't fit in what's left of today starts tomorrow instead;
    the leftover hours are idle. (A job longer than a whole day still has to span days.)"""
    validate_plan(plan, inputs)
    days = _week_days(cfg)
    shop_days = [d for d in days if _day_name(d) in cfg.shop.open_days]
    ready_delay = timedelta(days=cfg.shop.ready_delay_days)
    hours_per_day = cfg.shop.tech_hours_per_day

    # --- Shop: work the queue day by day (assumption A) ----------------------
    shop_queue: list[ShopRow] = []
    day_i, hours_left = 0, hours_per_day
    for item in (p for p in plan if p.assignment == SHOP):
        job = inputs.jobs[item.work_order_id]
        remaining, start, finish = job.shop_hours, None, None
        segments: list[DaySegment] = []
        while remaining > EPS and day_i < len(shop_days):
            if (not split_jobs and remaining > hours_left + EPS
                    and hours_left < hours_per_day - EPS):     # doesn't fit today: start tomorrow
                day_i, hours_left = day_i + 1, hours_per_day
                continue
            start = start or shop_days[day_i]
            work = min(remaining, hours_left)
            segments.append(DaySegment(shop_days[day_i], work))
            remaining -= work
            hours_left -= work
            if remaining <= EPS:
                finish = shop_days[day_i]
            if hours_left <= EPS:
                day_i, hours_left = day_i + 1, hours_per_day
        worked = job.shop_hours - remaining
        cost = worked * cfg.shop.labor_rate_per_hour + (job.parts_cost if worked > EPS else 0.0)  # assumption B
        shop_queue.append(ShopRow(
            position=len(shop_queue) + 1, work_order_id=job.work_order_id,
            vehicle_class=job.vehicle_class, job_type=job.job_type, opened_ts=job.opened_ts,
            shop_hours=job.shop_hours, hours_worked=worked, start_day=start, finish_day=finish,
            ready_date=finish + ready_delay if finish else None, shop_cost=cost,
            segments=segments))

    # --- Vendor: sent on the first dispatch day (assumption C) ---------------
    send_day = next(d for d in days if _day_name(d) in cfg.vendor.dispatch_days)
    vendor = []
    for item in (p for p in plan if p.assignment == VENDOR):
        job = inputs.jobs[item.work_order_id]
        vendor.append(VendorRow(
            work_order_id=job.work_order_id, vehicle_class=job.vehicle_class,
            job_type=job.job_type, in_house=job.in_house, vendor_price=job.vendor_price,
            sent_date=send_day, ready_date=_add_vendor_days(send_day, job.vendor_days, cfg)))

    held = [HoldRow(j.work_order_id, j.vehicle_class, j.job_type, j.in_house)
            for j in (inputs.jobs[p.work_order_id] for p in plan if p.assignment == HOLD)]

    # --- Shortages: reservations - cars ready - cars back so far -------------
    returns = [(r.vehicle_class, r.ready_date) for r in shop_queue if r.ready_date] + \
              [(r.vehicle_class, r.ready_date) for r in vendor]
    shortages = []
    for d in sorted(inputs.demand, key=lambda x: (x.vehicle_class, x.date)):
        if not days[0] <= d.date <= days[-1]:
            continue
        back = sum(1 for cls, ready in returns if cls == d.vehicle_class and ready <= d.date)
        short = max(0, d.reservations - d.cars_ready - back)
        shortages.append(ShortageCell(
            date=d.date, vehicle_class=d.vehicle_class, reservations=d.reservations,
            cars_ready=d.cars_ready, cars_back=back, short=short,
            lost_revenue=short * inputs.daily_rate[d.vehicle_class]))

    shop_total = sum(r.shop_cost for r in shop_queue)
    vendor_total = sum(r.vendor_price for r in vendor)
    lost_total = sum(c.lost_revenue for c in shortages)
    costs = Costs(shop=shop_total, vendor=vendor_total, lost_revenue=lost_total,
                  total=shop_total + vendor_total + lost_total,
                  vendor_budget=cfg.vendor.weekly_budget,
                  budget_left=cfg.vendor.weekly_budget - vendor_total)
    return Week(shop_queue, vendor, held, shortages, costs, week_days=days,
                shop_days=shop_days, hours_per_day=hours_per_day)


# ----------------------------------------------------------------- plans ----
def oldest_first_plan(inputs: Inputs) -> list[PlanItem]:
    """Today's practice: shop works oldest first; vendor-only jobs go to the vendor."""
    jobs = sorted(inputs.jobs.values(), key=lambda j: (j.opened_ts, j.work_order_id))
    return [PlanItem(j.work_order_id, SHOP if j.in_house else VENDOR) for j in jobs]


def short_classes(inputs: Inputs, cfg: PlanningConfig) -> set[str]:
    """Classes where reservations exceed cars ready on any day of the plan week."""
    start, end = cfg.planning_week.start, cfg.planning_week.end
    return {d.vehicle_class for d in inputs.demand
            if start <= d.date <= end and d.reservations > d.cars_ready}


def short_first_plan(plan: list[PlanItem], inputs: Inputs, cfg: PlanningConfig) -> list[PlanItem]:
    """Suggested order: jobs for short classes first, then the rest; oldest first within each.
    Only reorders: each job keeps its current shop/vendor assignment."""
    short = short_classes(inputs, cfg)
    def key(p: PlanItem):
        j = inputs.jobs[p.work_order_id]
        return (j.vehicle_class not in short, j.opened_ts, j.work_order_id)
    return [PlanItem(p.work_order_id, p.assignment) for p in sorted(plan, key=key)]


# --------------------------------------------------------------- loading ----
def _as_datetime(v) -> datetime:
    if isinstance(v, datetime):
        return v.replace(tzinfo=None)
    return datetime.fromisoformat(str(v).replace("Z", "+00:00")).replace(tzinfo=None)


def _as_date(v) -> date:
    return v if isinstance(v, date) and not isinstance(v, datetime) else date.fromisoformat(str(v)[:10])


def _as_bool(v) -> bool:
    return v if isinstance(v, bool) else str(v).strip().lower() in ("true", "1", "y", "yes")


def _num(v):
    return None if v in (None, "") else float(v)


def build_inputs(work_orders: list[dict], job_types: list[dict],
                 vehicle_classes: list[dict], rental_demand: list[dict]) -> Inputs:
    """Build Inputs from silver-table rows (from the SQL warehouse or CSV)."""
    jt = {r["job_type"]: r for r in job_types}
    jobs = {}
    for w in work_orders:
        if w["status"] != "open":
            continue
        t = jt[w["job_type"]]
        jobs[w["work_order_id"]] = Job(
            work_order_id=w["work_order_id"], vehicle_id=w["vehicle_id"],
            vehicle_class=w["vehicle_class"], job_type=w["job_type"],
            opened_ts=_as_datetime(w["opened_ts"]), in_house=_as_bool(t["in_house"]),
            shop_hours=_num(t["shop_hours"]), parts_cost=_num(t["parts_cost"]),
            vendor_price=float(t["vendor_price"]), vendor_days=int(float(t["vendor_days"])))
    demand = [DemandDay(_as_date(r["date"]), r["vehicle_class"],
                        int(float(r["reservations"])), int(float(r["cars_ready"])))
              for r in rental_demand]
    rates = {r["vehicle_class"]: float(r["daily_rate"]) for r in vehicle_classes}
    return Inputs(jobs=jobs, demand=demand, daily_rate=rates)

"""Load and validate the manager-editable planning config (config/planning.yaml).

Usage:
    from backend.config import load_config
    cfg = load_config()
    cfg.shop.labor_rate_per_hour  # 68.0

Set PLANNING_CONFIG to use a different file.
"""
import os
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, model_validator

Weekday = Literal["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config" / "planning.yaml"


class PlanningWeek(BaseModel):
    start: date
    end: date

    @model_validator(mode="after")
    def _check_range(self):
        if self.end < self.start:
            raise ValueError("planning_week.end must be on or after planning_week.start")
        return self


class Shop(BaseModel):
    tech_hours_per_day: float = Field(gt=0)
    open_days: list[Weekday] = Field(min_length=1)
    labor_rate_per_hour: float = Field(ge=0)
    ready_delay_days: int = Field(ge=0)


class Vendor(BaseModel):
    weekly_budget: float = Field(ge=0)
    dispatch_days: list[Weekday] = Field(min_length=1)
    turnaround_counts_weekends: bool


class PlanningConfig(BaseModel):
    planning_week: PlanningWeek
    shop: Shop
    vendor: Vendor


def _config_path() -> Path:
    return Path(os.environ.get("PLANNING_CONFIG", DEFAULT_PATH))


@lru_cache(maxsize=1)
def load_config() -> PlanningConfig:
    """Read the YAML file once; raises a readable error if a value is invalid."""
    path = _config_path()
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    return PlanningConfig.model_validate(raw)

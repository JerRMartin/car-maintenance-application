import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

// ---------------------------------------------------------------- types ----
type Assignment = 'shop' | 'vendor' | 'hold'

interface ShopRow {
  position: number
  work_order_id: string
  vehicle_class: string
  job_type: string
  shop_hours: number
  hours_worked: number
  start_day: string | null
  ready_date: string | null
  shop_cost: number
}
interface VendorRow {
  work_order_id: string
  vehicle_class: string
  job_type: string
  in_house: boolean
  vendor_price: number
  sent_date: string
  ready_date: string
}
interface HoldRow {
  work_order_id: string
  vehicle_class: string
  job_type: string
  in_house: boolean
}
interface ShortageCell {
  date: string
  vehicle_class: string
  short: number
  lost_revenue: number
}
interface Costs {
  shop: number
  vendor: number
  lost_revenue: number
  total: number
  vendor_budget: number
  budget_left: number
}
interface Preview {
  total_change: number
  budget_left: number
}
interface Decision {
  id: number
  made_at: string
  made_by: string
  action: string
  work_order_id: string | null
  detail: Record<string, unknown> | null
  week_cost_before: number | null
  week_cost_after: number | null
}
interface WeekResponse {
  week: {
    shop_queue: ShopRow[]
    vendor: VendorRow[]
    held: HoldRow[]
    shortages: ShortageCell[]
    costs: Costs
    week_days: string[]
  }
  baseline_total: number
  previews: Record<string, Partial<Record<Assignment, Preview>>>
  jobs: Record<string, { vehicle_id: string; in_house: boolean }>
  decisions: Decision[]
  config: {
    shop: { tech_hours_per_day: number; labor_rate_per_hour: number; open_days: string[] }
    vendor: { weekly_budget: number }
  }
  storage: 'lakebase' | 'memory'
}

// ------------------------------------------------------------- helpers ----
const money = (n: number) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US')
const signed = (n: number) => (Math.round(n) === 0 ? '±$0' : (n > 0 ? '+' : '−') + money(n))
const parseDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}
const day = (iso: string | null) =>
  iso ? parseDay(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) : ''
const className = (c: string) =>
  c.replace(/\b\w/g, (ch) => ch.toUpperCase()).replace('Suv', 'SUV')
const jobName = (j: string) => j.replace(/\b\w/g, (ch) => ch.toUpperCase()).replace('Ac ', 'AC ')

const ACTION_LABEL: Record<string, string> = {
  move: 'Moved in queue',
  send_to_vendor: 'Sent to vendor',
  bring_to_shop: 'Brought back to shop',
  hold: 'Put on hold',
  use_suggested: 'Used suggested order',
  reset_to_oldest_first: 'Reset to oldest first',
  start_plan: 'Week started (oldest first)',
  job_added: 'New work order added',
  job_removed: 'Work order closed',
}

// ---------------------------------------------------------------- app ----
export default function App() {
  const [data, setData] = useState<WeekResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/week')
      if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText)
      setData(await r.json())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const decide = async (action: string, work_order_id?: string, to_position?: number) => {
    setBusy(true)
    try {
      const r = await fetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, work_order_id, to_position }),
      })
      if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText)
      setData(await r.json())
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!data) {
    return (
      <main className="page">
        <h1>Fleet maintenance planner</h1>
        {error ? <p className="error">Couldn't load the week: {error}</p> : <p className="muted">Loading the week…</p>}
      </main>
    )
  }

  const { week, previews, decisions } = data
  const days = week.week_days

  return (
    <main className={busy ? 'page busy' : 'page'}>
      <header className="top">
        <div>
          <h1>Fleet maintenance planner</h1>
          <p className="muted">
            Week of {day(days[0])} – {day(days[days.length - 1])} · shop {data.config.shop.tech_hours_per_day} tech
            hrs/day, {data.config.shop.open_days.join('–')} · ${data.config.shop.labor_rate_per_hour}/hr
          </p>
        </div>
        <div className="top-actions">
          <button disabled title="Coming next: we're agreeing the ranking rule first">
            Use suggested order
          </button>
          <button disabled={busy} onClick={() => decide('reset_to_oldest_first')}>
            Reset to oldest first
          </button>
        </div>
      </header>

      {data.storage === 'memory' && (
        <p className="warning">
          Decisions are not being saved: no Lakebase database is connected, so changes are lost on restart.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <CostCards costs={week.costs} baseline={data.baseline_total} />

      <section>
        <h2>Cars short per day</h2>
        <ShortageGrid cells={week.shortages} days={days} />
      </section>

      <section>
        <h2>
          Shop queue <span className="muted">· worked top to bottom</span>
        </h2>
        <ShopQueue rows={week.shop_queue} previews={previews} busy={busy} decide={decide} jobs={data.jobs} />
      </section>

      <div className="two-col">
        <section>
          <h2>Sent to vendor</h2>
          <VendorList rows={week.vendor} previews={previews} busy={busy} decide={decide} />
        </section>
        <section>
          <h2>On hold</h2>
          <HeldList rows={week.held} previews={previews} busy={busy} decide={decide} />
        </section>
      </div>

      <section>
        <h2>Decision log</h2>
        <DecisionLog decisions={decisions} />
      </section>
    </main>
  )
}

// --------------------------------------------------------------- parts ----
function CostCards({ costs, baseline }: { costs: Costs; baseline: number }) {
  const saved = baseline - costs.total
  const overBudget = costs.budget_left < 0
  const used = Math.min(100, (costs.vendor / costs.vendor_budget) * 100)
  return (
    <div className="cards">
      <div className="card total">
        <span className="label">Cost of the week</span>
        <span className="value">{money(costs.total)}</span>
        <span className={saved > 0 ? 'note good' : 'note'}>
          {Math.round(saved) === 0 ? 'Same as oldest first' : `${signed(-saved)} vs oldest first (${money(baseline)})`}
        </span>
      </div>
      <div className="card">
        <span className="label">Shop</span>
        <span className="value">{money(costs.shop)}</span>
        <span className="note">labor + parts</span>
      </div>
      <div className="card">
        <span className="label">Vendor</span>
        <span className="value">{money(costs.vendor)}</span>
        <span className="note">of {money(costs.vendor_budget)} budget</span>
      </div>
      <div className="card">
        <span className="label">Lost revenue</span>
        <span className="value">{money(costs.lost_revenue)}</span>
        <span className="note">short cars × daily rate</span>
      </div>
      <div className={overBudget ? 'card over' : 'card'}>
        <span className="label">Vendor budget left</span>
        <span className="value">{overBudget ? '−' + money(costs.budget_left) : money(costs.budget_left)}</span>
        <div className="bar" aria-hidden>
          <div style={{ width: `${used}%` }} />
        </div>
        <span className="note">{overBudget ? `Over budget by ${money(costs.budget_left)}` : `${used.toFixed(0)}% used`}</span>
      </div>
    </div>
  )
}

function ShortageGrid({ cells, days }: { cells: ShortageCell[]; days: string[] }) {
  const classes = useMemo(() => {
    const lost: Record<string, number> = {}
    cells.forEach((c) => (lost[c.vehicle_class] = (lost[c.vehicle_class] ?? 0) + c.lost_revenue))
    return Object.entries(lost).sort((a, b) => b[1] - a[1])
  }, [cells])
  const max = Math.max(1, ...cells.map((c) => c.short))
  const get = (cls: string, d: string) => cells.find((c) => c.vehicle_class === cls && c.date === d)
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>Class</th>
            {days.map((d) => (
              <th key={d} className="num">
                {day(d)}
              </th>
            ))}
            <th className="num">Lost revenue</th>
          </tr>
        </thead>
        <tbody>
          {classes.map(([cls, lost]) => (
            <tr key={cls}>
              <td>{className(cls)}</td>
              {days.map((d) => {
                const short = get(cls, d)?.short ?? 0
                return (
                  <td
                    key={d}
                    className={short ? 'num short' : 'num zero'}
                    style={short ? { background: `rgba(227, 73, 72, ${0.12 + 0.5 * (short / max)})` } : undefined}
                    title={short ? `${short} customers without a car` : 'No shortage'}
                  >
                    {short || '–'}
                  </td>
                )
              })}
              <td className="num">{lost ? money(lost) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Decide = (action: string, work_order_id?: string, to_position?: number) => void

function Effect({ p }: { p?: Preview }) {
  if (!p) return null
  return (
    <span className={p.total_change < 0 ? 'effect good' : p.total_change > 0 ? 'effect bad' : 'effect'}>
      {signed(p.total_change)} · {p.budget_left < 0 ? 'over by ' + money(p.budget_left) : money(p.budget_left) + ' left'}
    </span>
  )
}

function ShopQueue({
  rows,
  previews,
  busy,
  decide,
  jobs,
}: {
  rows: ShopRow[]
  previews: WeekResponse['previews']
  busy: boolean
  decide: Decide
  jobs: WeekResponse['jobs']
}) {
  const [moveTo, setMoveTo] = useState<Record<string, string>>({})
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Order</th>
            <th>Vehicle</th>
            <th>Class</th>
            <th>Job</th>
            <th className="num">Hours</th>
            <th>Ready to rent</th>
            <th className="num">Shop cost</th>
            <th>Reorder</th>
            <th>Vendor</th>
            <th>Hold</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const partial = r.hours_worked > 0 && !r.ready_date
            return (
              <tr key={r.work_order_id} className={r.ready_date ? '' : 'later'}>
                <td className="num">{r.position}</td>
                <td className="mono">{r.work_order_id}</td>
                <td className="mono muted">{jobs[r.work_order_id]?.vehicle_id}</td>
                <td>{className(r.vehicle_class)}</td>
                <td>{jobName(r.job_type)}</td>
                <td className="num">{r.shop_hours}</td>
                <td>
                  {r.ready_date ? day(r.ready_date) : partial ? 'Not this week (started)' : 'Not this week'}
                </td>
                <td className="num">{r.shop_cost ? money(r.shop_cost) : '–'}</td>
                <td>
                  <div className="reorder">
                  <button
                    aria-label="Move up"
                    disabled={busy || r.position === 1}
                    onClick={() => decide('move', r.work_order_id, r.position - 1)}
                  >
                    ▲
                  </button>
                  <button
                    aria-label="Move down"
                    disabled={busy || r.position === rows.length}
                    onClick={() => decide('move', r.work_order_id, r.position + 1)}
                  >
                    ▼
                  </button>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      const to = parseInt(moveTo[r.work_order_id] ?? '', 10)
                      if (to) decide('move', r.work_order_id, to)
                      setMoveTo({ ...moveTo, [r.work_order_id]: '' })
                    }}
                  >
                    <input
                      aria-label={`Move ${r.work_order_id} to position`}
                      placeholder="#"
                      inputMode="numeric"
                      value={moveTo[r.work_order_id] ?? ''}
                      onChange={(e) => setMoveTo({ ...moveTo, [r.work_order_id]: e.target.value })}
                    />
                  </form>
                  </div>
                </td>
                <td>
                  <button disabled={busy} onClick={() => decide('send_to_vendor', r.work_order_id)}>
                    Send to vendor
                  </button>
                  <Effect p={previews[r.work_order_id]?.vendor} />
                </td>
                <td>
                  <button disabled={busy} onClick={() => decide('hold', r.work_order_id)}>
                    Hold
                  </button>
                  <Effect p={previews[r.work_order_id]?.hold} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function VendorList({
  rows,
  previews,
  busy,
  decide,
}: {
  rows: VendorRow[]
  previews: WeekResponse['previews']
  busy: boolean
  decide: Decide
}) {
  if (!rows.length) return <p className="muted">No jobs sent to the vendor.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Class</th>
            <th>Job</th>
            <th className="num">Price</th>
            <th>Ready to rent</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.work_order_id}>
              <td className="mono">{r.work_order_id}</td>
              <td>{className(r.vehicle_class)}</td>
              <td>
                {jobName(r.job_type)}
                {!r.in_house && <span className="tag">vendor-only</span>}
              </td>
              <td className="num">{money(r.vendor_price)}</td>
              <td>{day(r.ready_date)}</td>
              <td>
                <div className="stack">
                {r.in_house && (
                  <span>
                    <button disabled={busy} onClick={() => decide('bring_to_shop', r.work_order_id)}>
                      Repair in house
                    </button>
                    <Effect p={previews[r.work_order_id]?.shop} />
                  </span>
                )}
                <span>
                  <button disabled={busy} onClick={() => decide('hold', r.work_order_id)}>
                    Hold
                  </button>
                  <Effect p={previews[r.work_order_id]?.hold} />
                </span>
              </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HeldList({
  rows,
  previews,
  busy,
  decide,
}: {
  rows: HoldRow[]
  previews: WeekResponse['previews']
  busy: boolean
  decide: Decide
}) {
  if (!rows.length) return <p className="muted">Nothing on hold.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Class</th>
            <th>Job</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.work_order_id}>
              <td className="mono">{r.work_order_id}</td>
              <td>{className(r.vehicle_class)}</td>
              <td>
                {jobName(r.job_type)}
                {!r.in_house && <span className="tag">vendor-only</span>}
              </td>
              <td>
                <div className="stack">
                {r.in_house && (
                  <span>
                    <button disabled={busy} onClick={() => decide('bring_to_shop', r.work_order_id)}>
                      Repair in house
                    </button>
                    <Effect p={previews[r.work_order_id]?.shop} />
                  </span>
                )}
                <span>
                  <button disabled={busy} onClick={() => decide('send_to_vendor', r.work_order_id)}>
                    Send to vendor
                  </button>
                  <Effect p={previews[r.work_order_id]?.vendor} />
                </span>
              </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DecisionLog({ decisions }: { decisions: Decision[] }) {
  if (!decisions.length) return <p className="muted">No decisions yet.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Decision</th>
            <th>Order</th>
            <th>Detail</th>
            <th className="num">Week cost</th>
            <th className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d) => {
            const change =
              d.week_cost_before != null && d.week_cost_after != null
                ? Number(d.week_cost_after) - Number(d.week_cost_before)
                : null
            return (
              <tr key={d.id}>
                <td className="muted">{new Date(d.made_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{d.made_by}</td>
                <td>{ACTION_LABEL[d.action] ?? d.action}</td>
                <td className="mono">{d.work_order_id ?? ''}</td>
                <td className="muted">
                  {d.detail && 'from' in d.detail ? `${String(d.detail.from)} → ${String(d.detail.to)}` : ''}
                </td>
                <td className="num">{d.week_cost_after != null ? money(Number(d.week_cost_after)) : ''}</td>
                <td className={change == null ? 'num' : change < 0 ? 'num good' : change > 0 ? 'num bad' : 'num'}>
                  {change == null ? '' : signed(change)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
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
  segments: { day: string; hours: number }[]
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
type Goal = 'savings' | 'readiness'
interface OptionPreview {
  total: number
  lost_revenue: number
  budget_left: number
  car_days_short: number
  vendor_sends: number
}
interface WeekResponse {
  week: {
    shop_queue: ShopRow[]
    vendor: VendorRow[]
    held: HoldRow[]
    shortages: ShortageCell[]
    costs: Costs
    week_days: string[]
    shop_days: string[]
    hours_per_day: number
  }
  baseline_total: number
  optimize: Record<Goal, OptionPreview>
  short_classes: string[]
  previews: Record<string, Partial<Record<Assignment, Preview>>>
  jobs: Record<string, { vehicle_id: string; in_house: boolean; vendor_price: number; vendor_days: number; shop_cost: number | null }>
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
const addDays = (iso: string, n: number) => {
  const d = parseDay(iso)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const daysText = (n: number) => `${n} day${n === 1 ? '' : 's'}`
const GOAL_LABEL: Record<Goal, string> = { savings: 'Savings', readiness: 'Car readiness' }
const GOAL_HELP: Record<Goal, string> = {
  savings: 'Lowest cost of the week',
  readiness: 'Fewest cars short within the vendor budget',
}
const className = (c: string) =>
  c.replace(/\b\w/g, (ch) => ch.toUpperCase()).replace('Suv', 'SUV')
const jobName = (j: string) => j.replace(/\b\w/g, (ch) => ch.toUpperCase()).replace('Ac ', 'AC ')

const ACTION_LABEL: Record<string, string> = {
  move: 'Moved in queue',
  send_to_vendor: 'Sent to vendor',
  bring_to_shop: 'Brought back to shop',
  hold: 'Not sent this week',
  use_suggested: 'Optimized plan',
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
  const page = usePage()
  const [confirmReset, setConfirmReset] = useState(false)
  const [deferRow, setDeferRow] = useState<VendorRow | null>(null)

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

  const decide = async (action: string, work_order_id?: string, to_position?: number, goal?: Goal) => {
    setBusy(true)
    try {
      const r = await fetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, work_order_id, to_position, goal }),
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
        <p className="eyebrow">Fleet maintenance</p>
        <h1>Maintenance planner</h1>
        {error ? <p className="error">Couldn't load the week: {error}</p> : <p className="muted">Loading the week…</p>}
      </main>
    )
  }

  const { week, previews, decisions } = data
  const days = week.week_days
  const weekLabel = `${day(days[0])} – ${day(days[days.length - 1])}`
  // Classes that need cars this week (short before any repairs): same rule as "Use suggested order"
  const shortClasses = new Set(data.short_classes)
  const meta = PAGES.find((p) => p.id === page) ?? PAGES[0]
  const counts: Partial<Record<Page, number>> = {
    queue: week.shop_queue.length,
    vendor: week.vendor.length + week.held.length,
    log: decisions.length,
  }

  return (
    <div className={busy ? 'layout busy' : 'layout'}>
      <Sidebar page={page} counts={counts} />
      <main className="page">
        <header className="top">
          <div>
            <p className="eyebrow">Fleet maintenance · {weekLabel}</p>
            <h1>{meta.label}</h1>
            <p className="muted">{meta.subtitle}</p>
          </div>
          <div className="top-actions">
            <OptimizeButton
              busy={busy}
              current={week.costs.total}
              options={data.optimize}
              onRun={(goal) => decide('use_suggested', undefined, undefined, goal)}
            />
            <button className="btn-outline" disabled={busy} onClick={() => setConfirmReset(true)}>
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

        {page === 'summary' && (
          <>
            <section>
              <SectionTitle title="Cost of the week" subtitle="Shop + vendor + lost revenue for the plan week." badge={weekLabel} />
              <CostCards costs={week.costs} baseline={data.baseline_total} />
              <p className="muted assumptions">
                Shop: {data.config.shop.tech_hours_per_day} tech hrs/day, {data.config.shop.open_days.join('–')} · $
                {data.config.shop.labor_rate_per_hour}/hr · Vendor budget {money(data.config.vendor.weekly_budget)}/week
              </p>
            </section>
            <section>
              <TodayQueue rows={week.shop_queue} shopDays={week.shop_days} hoursPerDay={week.hours_per_day} shortClasses={shortClasses} />
            </section>
            <section>
              <SectionTitle title="Still short" subtitle="Classes that will still turn customers away this week, with the current plan." />
              <ShortSummary cells={week.shortages} />
              <a className="see-all" href="#/shortages">
                See cars short by day →
              </a>
            </section>
          </>
        )}

        {page === 'shortages' && (
          <section>
            <ShortageGrid cells={week.shortages} days={days} />
          </section>
        )}

        {page === 'queue' && (
          <>
            <section>
              <CostCards costs={week.costs} baseline={data.baseline_total} />
            </section>
            <section>
              <QueuePage
                rows={week.shop_queue}
                previews={previews}
                costs={week.costs}
                busy={busy}
                decide={decide}
                jobs={data.jobs}
                shortClasses={shortClasses}
                shopDays={week.shop_days}
                hoursPerDay={week.hours_per_day}
              />
            </section>
          </>
        )}

        {page === 'vendor' && (
          <>
            <section>
              <CostCards costs={week.costs} baseline={data.baseline_total} />
            </section>
            <VendorBoard
              vendor={week.vendor}
              notSent={week.held}
              jobs={data.jobs}
              sendDay={days[0]}
              previews={previews}
              costs={week.costs}
              busy={busy}
              decide={decide}
              onDefer={setDeferRow}
            />
          </>
        )}

        {page === 'log' && (
          <section>
            <DecisionLog decisions={decisions} />
          </section>
        )}
      </main>
      {deferRow && (
        <ConfirmDialog
          title={`Don't send ${deferRow.work_order_id} this week?`}
          confirmLabel="Don't send"
          onCancel={() => setDeferRow(null)}
          onConfirm={() => {
            const wo = deferRow.work_order_id
            setDeferRow(null)
            decide('hold', wo)
          }}
        >
          <p className="warn-line">
            ⚠ <strong>{jobName(deferRow.job_type)}</strong> on this <strong>{className(deferRow.vehicle_class)}</strong> car
            takes <strong>{daysText(data.jobs[deferRow.work_order_id]?.vendor_days ?? 0)}</strong> at the vendor. Not sending it
            this week delays this car by a week.
          </p>
          <table className="mini">
            <tbody>
              <tr>
                <td>Sent this week ({day(deferRow.sent_date)})</td>
                <td>
                  back <strong>{day(deferRow.ready_date)}</strong>
                </td>
              </tr>
              <tr>
                <td>Sent next week ({day(addDays(deferRow.sent_date, 7))})</td>
                <td>
                  back <strong>{day(addDays(deferRow.ready_date, 7))}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </ConfirmDialog>
      )}
      {confirmReset && (
        <ConfirmDialog
          title="Reset to oldest first?"
          confirmLabel="Reset plan"
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false)
            decide('reset_to_oldest_first')
          }}
        >
          <p>
            This replaces the current plan with the shop's default order: every in-house job oldest first, and vendor-only
            jobs sent to the vendor.
          </p>
          <p>
            Week cost: <strong>{money(week.costs.total)}</strong> → <strong>{money(data.baseline_total)}</strong>
            {Math.round(data.baseline_total - week.costs.total) !== 0 && (
              <span className={data.baseline_total > week.costs.total ? 'bad' : 'good'}>
                {' '}
                ({signed(data.baseline_total - week.costs.total)})
              </span>
            )}
          </p>
          <p className="muted">Your earlier decisions stay in the decision log.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

// Branded "are you sure?" dialog. Cancel has focus; Esc or clicking outside cancels.
function ConfirmDialog({
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: {
  title: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button ref={cancelRef} className="btn-outline" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------- summary parts ----
// "Today" is today's date if it's a shop day in the plan week, otherwise the plan's first shop day.
function planDay(shopDays: string[]): { day: string; isToday: boolean } {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return shopDays.includes(today) ? { day: today, isToday: true } : { day: shopDays[0], isToday: false }
}

function TodayQueue({
  rows,
  shopDays,
  hoursPerDay,
  shortClasses,
}: {
  rows: ShopRow[]
  shopDays: string[]
  hoursPerDay: number
  shortClasses: Set<string>
}) {
  const { day: d, isToday } = planDay(shopDays)
  const items = rows.flatMap((r) => {
    const i = r.segments.findIndex((g) => g.day === d)
    return i < 0 ? [] : [{ r, hours: r.segments[i].hours, continued: i > 0, continues: i < r.segments.length - 1 || !r.ready_date }]
  })
  const used = items.reduce((sum, x) => sum + x.hours, 0)
  return (
    <>
      <SectionTitle
        title={isToday ? "Today's shop queue" : `Shop queue for ${day(d)}`}
        subtitle={isToday ? 'Jobs the shop works today, in order.' : 'First day of the plan week (today is outside it).'}
      />
      <div className="today-cap">
        <div className="bar" aria-hidden>
          <div style={{ width: `${Math.min(100, (used / hoursPerDay) * 100)}%` }} />
        </div>
        <span className="muted">
          {+used.toFixed(2)} of {hoursPerDay} tech hours · {items.length} jobs
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Order</th>
              <th>Class</th>
              <th>Job</th>
              <th className="num">Hours</th>
              <th>Ready to rent</th>
            </tr>
          </thead>
          <tbody>
            {items.map(({ r, hours, continued, continues }) => (
              <tr key={r.work_order_id}>
                <td className="num">{r.position}</td>
                <td className="mono">{r.work_order_id}</td>
                <td>
                  {className(r.vehicle_class)}
                  {shortClasses.has(r.vehicle_class) && <span className="tag short-tag" title="Reservations exceed cars ready on at least one day of the plan week">short</span>}
                </td>
                <td>{jobName(r.job_type)}</td>
                <td className="num">{hours === r.shop_hours ? hours : `${+hours.toFixed(2)} of ${r.shop_hours}`}</td>
                <td>
                  {continues ? (
                    <span className="muted">{r.ready_date ? `Continues, ready ${day(r.ready_date)}` : 'Continues next week'}</span>
                  ) : (
                    day(r.ready_date)
                  )}
                  {continued && <span className="muted"> (started earlier)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <a className="see-all" href="#/queue">
        Plan the week by day →
      </a>
    </>
  )
}

function ShortSummary({ cells }: { cells: ShortageCell[] }) {
  const rows = useMemo(() => {
    const by: Record<string, { carDays: number; lost: number; peak: number; peakDay: string }> = {}
    for (const c of cells) {
      const b = (by[c.vehicle_class] ??= { carDays: 0, lost: 0, peak: 0, peakDay: c.date })
      b.carDays += c.short
      b.lost += c.lost_revenue
      if (c.short > b.peak) {
        b.peak = c.short
        b.peakDay = c.date
      }
    }
    return Object.entries(by)
      .filter(([, b]) => b.carDays > 0)
      .sort((a, b) => b[1].lost - a[1].lost)
  }, [cells])
  if (!rows.length) return <p className="muted">No class is short this week.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Class</th>
            <th className="num">Worst day</th>
            <th className="num">Car-days short</th>
            <th className="num">Lost revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([cls, b]) => (
            <tr key={cls}>
              <td>{className(cls)}</td>
              <td className="num">
                <strong>{b.peak}</strong> short on {day(b.peakDay)}
              </td>
              <td className="num">{b.carDays}</td>
              <td className="num">{money(b.lost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------- layout ----
type Page = 'summary' | 'shortages' | 'queue' | 'vendor' | 'log'

const PAGES: { id: Page; label: string; subtitle: string }[] = [
  { id: 'summary', label: 'Summary', subtitle: 'The week at a glance.' },
  { id: 'shortages', label: 'Cars short', subtitle: 'Customers without a car, by class and day.' },
  { id: 'queue', label: 'In-House Repairs', subtitle: 'Worked top to bottom. Reorder jobs, or send one to the vendor.' },
  { id: 'vendor', label: 'Vendor Repairs', subtitle: 'What goes to the outside vendor, when it is sent, and when it is back to rent.' },
  { id: 'log', label: 'Decision log', subtitle: 'Every change, who made it, and what it did to the week.' },
]

// Pages live in the URL hash (#/queue) so back/forward and refresh work
// without the server needing to know about each page.
function readPage(): Page {
  const id = window.location.hash.replace(/^#\/?/, '')
  return PAGES.some((p) => p.id === id) ? (id as Page) : 'summary'
}

function usePage(): Page {
  const [page, setPage] = useState<Page>(readPage)
  useEffect(() => {
    const onChange = () => {
      setPage(readPage())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return page
}

function Sidebar({ page, counts }: { page: Page; counts: Partial<Record<Page, number>> }) {
  return (
    <nav className="sidebar" aria-label="Pages">
      <Brand />
      <p className="nav-group">Planner</p>
      {PAGES.map((p) => (
        <a key={p.id} href={`#/${p.id}`} className={page === p.id ? 'nav-item active' : 'nav-item'} aria-current={page === p.id ? 'page' : undefined}>
          {p.label}
          {counts[p.id] != null && <span className="nav-count">{counts[p.id]}</span>}
        </a>
      ))}
    </nav>
  )
}

// Official logo: frontend/public/Hertz_logo.jpg (falls back to the name as text if missing).
function Brand() {
  const [logoOk, setLogoOk] = useState(true)
  return (
    <div className="brand">
      {logoOk ? (
        <img src="/Hertz_logo.jpg" alt="Hertz" onError={() => setLogoOk(false)} />
      ) : (
        <span className="brand-text">Hertz</span>
      )}
      <span className="brand-product">Fleet Maintenance</span>
    </div>
  )
}

function SectionTitle({ title, subtitle, badge }: { title: string; subtitle: string; badge?: string }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <p className="muted">{subtitle}</p>
      {badge && <span className="badge">{badge}</span>}
    </div>
  )
}

// --------------------------------------------------------------- parts ----
function CostCards({ costs, baseline }: { costs: Costs; baseline: number }) {
  const saved = baseline - costs.total
  const overBudget = costs.budget_left < 0
  const used = Math.min(100, (costs.vendor / costs.vendor_budget) * 100)
  // Budget bar color: green < 60% used, yellow < 85%, orange up to 100%, red when over
  const budgetLevel = overBudget ? 'over' : used < 60 ? 'low' : used < 85 ? 'mid' : 'high'
  return (
    <div className="cards">
      <div className="card total">
        <span className="label">Cost of the week</span>
        <span className="value">
          {money(costs.total)}
          {Math.round(saved) !== 0 && (
            <span className={saved > 0 ? 'delta down' : 'delta up'}>
              {saved > 0 ? '↓' : '↑'}
              {money(saved)}
            </span>
          )}
        </span>
        <span className="note">
          {Math.round(saved) === 0 ? 'Same as oldest first' : `vs ${money(baseline)} working oldest first`}
        </span>
      </div>
      <div className="card">
        <span className="label">Shop</span>
        <span className="value">{money(costs.shop)}</span>
        <span className="note">labor + parts</span>
      </div>
      <div className={overBudget ? 'card over' : 'card'}>
        <span className="label">Vendor</span>
        <span className="value">{money(costs.vendor)}</span>
        <div className={`bar budget-${budgetLevel}`} aria-hidden>
          <div style={{ width: `${used}%` }} />
        </div>
        <span className="note">
          {overBudget
            ? `Over the ${money(costs.vendor_budget)} budget by ${money(costs.budget_left)}`
            : `${money(costs.budget_left)} left of ${money(costs.vendor_budget)} budget`}
        </span>
      </div>
      <div className="card">
        <span className="label">Lost revenue</span>
        <span className="value">{money(costs.lost_revenue)}</span>
        <span className="note">short cars × daily rate</span>
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
    <>
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
                    title={short ? `${short} customers without a car` : 'Not short: enough cars for every reservation'}
                  >
                    {short}
                  </td>
                )
              })}
              <td className={lost ? 'num' : 'num zero'}>{money(lost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

type Decide = (action: string, work_order_id?: string, to_position?: number, goal?: Goal) => void

const PREVIEW_KEY: Record<string, Assignment> = { send_to_vendor: 'vendor', bring_to_shop: 'shop', hold: 'hold' }
const ACTION_TEXT: Record<string, string> = {
  send_to_vendor: 'Send %s to the vendor',
  bring_to_shop: 'Repair %s in house',
  hold: "Don't send %s to the vendor this week",
}
const budgetText = (n: number) => (n < 0 ? `over budget by ${money(n)}` : money(n))

// Tooltip: what this choice would do to the week, in plain words.
function impactText(action: string, wo: string, previews: WeekResponse['previews'], costs: Costs): string {
  const title = ACTION_TEXT[action].replace('%s', wo)
  const p = previews[wo]?.[PREVIEW_KEY[action]]
  if (!p) return title
  return [
    title,
    `Week cost: ${money(costs.total)} → ${money(costs.total + p.total_change)} (${signed(p.total_change)})`,
    `Vendor budget left: ${budgetText(costs.budget_left)} → ${budgetText(p.budget_left)}`,
  ].join('\n')
}

// Final queue position once the dragged job is taken out of its old spot.
function moveTarget(from: number, position: number, after: boolean): number {
  const to = after ? position + 1 : position
  return from < to ? to - 1 : to
}

type QueueProps = {
  rows: ShopRow[]
  previews: WeekResponse['previews']
  costs: Costs
  busy: boolean
  decide: Decide
  jobs: WeekResponse['jobs']
  shortClasses: Set<string>
  shopDays: string[]
  hoursPerDay: number
}

function QueuePage(props: QueueProps) {
  const [tab, setTab] = useState<'day' | 'list'>('day')
  return (
    <>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'day'} className={tab === 'day' ? 'tab active' : 'tab'} onClick={() => setTab('day')}>
          By day
        </button>
        <button role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'tab active' : 'tab'} onClick={() => setTab('list')}>
          Full queue
        </button>
      </div>
      {tab === 'day' ? <DayBoard {...props} /> : <ShopQueue {...props} />}
    </>
  )
}

interface BoardCard {
  row: ShopRow
  hours: number
  continued: boolean // started on an earlier day
  continues: boolean // finishes on a later day (or next week)
}

function DayBoard({ rows, costs, busy, decide, jobs, shortClasses, previews, shopDays, hoursPerDay }: QueueProps) {
  const columns = useMemo(() => {
    const byDay = shopDays.map((d) => ({ key: d, cards: [] as BoardCard[] }))
    const later: BoardCard[] = []
    for (const row of rows) {
      if (!row.segments.length) {
        later.push({ row, hours: row.shop_hours, continued: false, continues: false })
        continue
      }
      row.segments.forEach((seg, i) => {
        const col = byDay.find((c) => c.key === seg.day)
        col?.cards.push({
          row,
          hours: seg.hours,
          continued: i > 0,
          continues: i < row.segments.length - 1 || !row.ready_date,
        })
      })
    }
    return { byDay, later }
  }, [rows, shopDays])

  const [dragging, setDragging] = useState<ShopRow | null>(null)
  const [dropAt, setDropAt] = useState<{ col: string; position: number; after: boolean } | null>(null)
  const endDrag = () => {
    setDragging(null)
    setDropAt(null)
  }
  const drop = () => {
    if (dragging && dropAt) {
      const to = moveTarget(dragging.position, dropAt.position, dropAt.after)
      if (to !== dragging.position) decide('move', dragging.work_order_id, to)
    }
    endDrag()
  }
  // Dropping on empty space at the bottom of a column = after its last job.
  const overColumn = (col: string, cards: BoardCard[]) => (e: DragEvent<HTMLDivElement>) => {
    if (!dragging || !cards.length) return
    e.preventDefault()
    const last = cards[cards.length - 1].row.position
    if (dropAt?.col !== col || dropAt.position !== last || !dropAt.after) setDropAt({ col, position: last, after: true })
  }

  const renderColumn = (key: string, title: string, cards: BoardCard[], isLater = false) => {
    const used = cards.reduce((sum, c) => sum + c.hours, 0)
    const pct = Math.min(100, (used / hoursPerDay) * 100)
    return (
      <div
        key={key}
        className={isLater ? 'day-col later-col' : 'day-col'}
        onDragOver={overColumn(key, cards)}
        onDrop={(e) => {
          e.preventDefault()
          drop()
        }}
      >
        <div className="day-head">
          <span className="day-title">{title}</span>
          {isLater ? (
            <span className="muted day-sub">
              {cards.length} jobs · {used} hrs of work
            </span>
          ) : (
            <>
              <div className="bar" aria-hidden>
                <div style={{ width: `${pct}%` }} />
              </div>
              <span className="muted day-sub">
                {+used.toFixed(2)} / {hoursPerDay} hrs · {cards.length} jobs
              </span>
            </>
          )}
        </div>
        <div className="day-cards">
          {cards.map((c) => {
            const r = c.row
            const marker =
              dropAt?.col === key && dropAt.position === r.position ? (dropAt.after ? 'drop-after' : 'drop-before') : ''
            return (
              <div
                key={`${r.work_order_id}-${key}`}
                className={['job-card', dragging?.work_order_id === r.work_order_id ? 'dragging' : '', marker].join(' ')}
                draggable={!busy}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', r.work_order_id)
                  setDragging(r)
                }}
                onDragOver={(e) => {
                  if (!dragging) return
                  e.preventDefault()
                  e.stopPropagation()
                  const box = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY > box.top + box.height / 2
                  if (dropAt?.col !== key || dropAt.position !== r.position || dropAt.after !== after)
                    setDropAt({ col: key, position: r.position, after })
                }}
                onDragEnd={endDrag}
                title={`#${r.position} in the queue · drag to another day to reschedule`}
              >
                <div className="card-top">
                  <span className="mono">{r.work_order_id}</span>
                  <span className="muted">#{r.position}</span>
                </div>
                <div className="card-class">
                  {className(r.vehicle_class)}
                  {shortClasses.has(r.vehicle_class) && <span className="tag short-tag" title="Reservations exceed cars ready on at least one day of the plan week">short</span>}
                </div>
                <div className="card-job">
                  {jobName(r.job_type)} ·{' '}
                  {c.hours === r.shop_hours ? `${r.shop_hours} h` : `${+c.hours.toFixed(2)} of ${r.shop_hours} h`}
                </div>
                <div className="card-foot">
                  {c.continued && <span className="muted">← continued from earlier</span>}
                  {c.continues ? (
                    <span className="muted">{r.ready_date ? 'continues →' : 'continues next week'}</span>
                  ) : isLater ? (
                    <span className="muted">Not this week</span>
                  ) : (
                    <span className="ready">Ready {day(r.ready_date)}</span>
                  )}
                </div>
                {!c.continued && (
                  <button
                    className="card-vendor"
                    disabled={busy}
                    title={impactText('send_to_vendor', r.work_order_id, previews, costs)}
                    onClick={() => decide('send_to_vendor', r.work_order_id)}
                  >
                    To vendor · {money(jobs[r.work_order_id]?.vendor_price ?? 0)}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <>
      <p className="muted board-hint">
        Each day's {hoursPerDay} tech hours are filled in queue order. Drag a job to another day to reschedule it; the jobs
        after it shift.
      </p>
      <div className="board">
        {columns.byDay.map((c) => renderColumn(c.key, day(c.key), c.cards))}
        {renderColumn('later', 'Not this week', columns.later, true)}
      </div>
    </>
  )
}

type SortKey = 'position' | 'vehicle_class' | 'job_type' | 'shop_hours' | 'ready_date' | 'shop_cost'
type ReadyFilter = 'all' | 'ready' | 'not_ready'

const SORT_VALUE: Record<SortKey, (r: ShopRow) => string | number> = {
  position: (r) => r.position,
  vehicle_class: (r) => r.vehicle_class,
  job_type: (r) => r.job_type,
  shop_hours: (r) => r.shop_hours,
  ready_date: (r) => r.ready_date ?? '9999-12-31', // not this week sorts last
  shop_cost: (r) => r.shop_cost,
}

function ShopQueue({
  rows,
  previews,
  costs,
  busy,
  decide,
  jobs,
  shortClasses,
}: {
  rows: ShopRow[]
  previews: WeekResponse['previews']
  costs: Costs
  busy: boolean
  decide: Decide
  jobs: WeekResponse['jobs']
  shortClasses: Set<string>
  shopDays?: string[]
  hoursPerDay?: number
}) {
  const [moveTo, setMoveTo] = useState<Record<string, string>>({})

  // --- Filters and sort: they change what's shown, never the plan itself ----
  const [search, setSearch] = useState('')
  const [cls, setCls] = useState('all')
  const [job, setJob] = useState('all')
  const [hours, setHours] = useState('all')
  const [ready, setReady] = useState<ReadyFilter>('all')
  const [onlyShort, setOnlyShort] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'position', desc: false })

  const classes = useMemo(() => [...new Set(rows.map((r) => r.vehicle_class))].sort(), [rows])
  const jobTypes = useMemo(() => [...new Set(rows.map((r) => r.job_type))].sort(), [rows])
  // Job lengths present in the queue, with how many jobs have each
  const hourOptions = useMemo(() => {
    const n = new Map<number, number>()
    rows.forEach((r) => n.set(r.shop_hours, (n.get(r.shop_hours) ?? 0) + 1))
    return [...n.entries()].sort((a, b) => a[0] - b[0])
  }, [rows])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = rows.filter(
      (r) =>
        (!q || r.work_order_id.toLowerCase().includes(q) || (jobs[r.work_order_id]?.vehicle_id ?? '').toLowerCase().includes(q)) &&
        (cls === 'all' || r.vehicle_class === cls) &&
        (job === 'all' || r.job_type === job) &&
        (hours === 'all' || r.shop_hours === Number(hours)) &&
        (ready === 'all' || (ready === 'ready' ? !!r.ready_date : !r.ready_date)) &&
        (!onlyShort || shortClasses.has(r.vehicle_class)),
    )
    const value = SORT_VALUE[sort.key]
    return out.sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      const c = va < vb ? -1 : va > vb ? 1 : a.position - b.position
      return sort.desc ? -c : c
    })
  }, [rows, jobs, search, cls, job, hours, ready, onlyShort, shortClasses, sort])

  const filtered = shown.length !== rows.length
  const queueOrder = sort.key === 'position' && !sort.desc
  const canReorder = !busy && queueOrder
  const clear = () => {
    setSearch('')
    setCls('all')
    setJob('all')
    setHours('all')
    setReady('all')
    setOnlyShort(false)
    setSort({ key: 'position', desc: false })
  }
  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: false }))
  const SortHeader = ({ k, label, num }: { k: SortKey; label: string; num?: boolean }) => (
    <th className={num ? 'num' : undefined} aria-sort={sort.key === k ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button className={sort.key === k ? 'sort active' : 'sort'} onClick={() => sortBy(k)}>
        {label}
        <span aria-hidden>{sort.key === k ? (sort.desc ? ' ↓' : ' ↑') : ''}</span>
      </button>
    </th>
  )

  // --- Drag and drop: drop above or below the hovered row ------------------
  const [dragging, setDragging] = useState<ShopRow | null>(null)
  const [dropAt, setDropAt] = useState<{ position: number; after: boolean } | null>(null)
  const endDrag = () => {
    setDragging(null)
    setDropAt(null)
  }
  const onDrop = () => {
    if (dragging && dropAt) {
      const from = dragging.position
      // Final position in the queue once the dragged row is taken out of its old spot.
      // Positions are real queue positions, so this also works while filtered.
      const to = moveTarget(from, dropAt.position, dropAt.after)
      if (to !== from) decide('move', dragging.work_order_id, to)
    }
    endDrag()
  }

  return (
    <>
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search order or vehicle"
          aria-label="Search by order or vehicle ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="Class" value={cls} onChange={(e) => setCls(e.target.value)}>
          <option value="all">All classes</option>
          {classes.map((c) => (
            <option key={c} value={c}>
              {className(c)}
            </option>
          ))}
        </select>
        <select aria-label="Job type" value={job} onChange={(e) => setJob(e.target.value)}>
          <option value="all">All jobs</option>
          {jobTypes.map((j) => (
            <option key={j} value={j}>
              {jobName(j)}
            </option>
          ))}
        </select>
        <select aria-label="Job hours" value={hours} onChange={(e) => setHours(e.target.value)}>
          <option value="all">Any hours</option>
          {hourOptions.map(([h, count]) => (
            <option key={h} value={String(h)}>
              {h} h ({count} {count === 1 ? 'job' : 'jobs'})
            </option>
          ))}
        </select>
        <select aria-label="Ready this week" value={ready} onChange={(e) => setReady(e.target.value as ReadyFilter)}>
          <option value="all">Any ready date</option>
          <option value="ready">Ready this week</option>
          <option value="not_ready">Not this week</option>
        </select>
        <label className={onlyShort ? 'chip on' : 'chip'}>
          <input type="checkbox" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} />
          Only classes with shortages
        </label>
        <span className="muted count">
          Showing {shown.length} of {rows.length}
        </span>
        {(filtered || !queueOrder) && (
          <button className="link" onClick={clear}>
            Clear
          </button>
        )}
      </div>
      {!queueOrder && (
        <p className="note-bar">
          Sorted view: reordering is off. Click <strong>#</strong> to return to queue order and drag jobs again.
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th aria-label="Drag to reorder" />
              <SortHeader k="position" label="#" num />
              <th>Order</th>
              <th>Vehicle</th>
              <SortHeader k="vehicle_class" label="Class" />
              <SortHeader k="job_type" label="Job" />
              <SortHeader k="shop_hours" label="Hours" num />
              <SortHeader k="ready_date" label="Ready to rent" />
              <SortHeader k="shop_cost" label="Shop cost" num />
              <th>Reorder</th>
              <th>Vendor</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={11} className="muted empty">
                  No jobs match these filters.
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const partial = r.hours_worked > 0 && !r.ready_date
              return (
                <tr
                  key={r.work_order_id}
                  className={[
                    r.ready_date ? '' : 'later',
                    dragging?.work_order_id === r.work_order_id ? 'dragging' : '',
                    dropAt?.position === r.position ? (dropAt.after ? 'drop-after' : 'drop-before') : '',
                  ].join(' ')}
                  draggable={canReorder}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', r.work_order_id)
                    setDragging(r)
                  }}
                  onDragOver={(e) => {
                    if (!dragging) return
                    e.preventDefault()
                    const box = e.currentTarget.getBoundingClientRect()
                    const after = e.clientY > box.top + box.height / 2
                    if (dropAt?.position !== r.position || dropAt.after !== after) setDropAt({ position: r.position, after })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    onDrop()
                  }}
                  onDragEnd={endDrag}
                >
                  <td className={canReorder ? 'grip' : 'grip off'} title={canReorder ? 'Drag to reorder' : undefined} aria-hidden>
                    ⠿
                  </td>
                  <td className="num">{r.position}</td>
                  <td className="mono">{r.work_order_id}</td>
                  <td className="mono muted">{jobs[r.work_order_id]?.vehicle_id}</td>
                  <td>
                    {className(r.vehicle_class)}
                    {shortClasses.has(r.vehicle_class) && <span className="tag short-tag" title="Reservations exceed cars ready on at least one day of the plan week">short</span>}
                  </td>
                  <td>{jobName(r.job_type)}</td>
                  <td className="num">{r.shop_hours}</td>
                  <td>{r.ready_date ? day(r.ready_date) : partial ? 'Not this week (started)' : 'Not this week'}</td>
                  <td className="num">{r.shop_cost ? money(r.shop_cost) : '–'}</td>
                  <td>
                    <div className="reorder">
                      <button
                        aria-label="Move up"
                        disabled={!canReorder || r.position === 1}
                        onClick={() => decide('move', r.work_order_id, r.position - 1)}
                      >
                        ▲
                      </button>
                      <button
                        aria-label="Move down"
                        disabled={!canReorder || r.position === rows.length}
                        onClick={() => decide('move', r.work_order_id, r.position + 1)}
                      >
                        ▼
                      </button>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          const to = parseInt(moveTo[r.work_order_id] ?? '', 10)
                          if (to && canReorder) decide('move', r.work_order_id, to)
                          setMoveTo({ ...moveTo, [r.work_order_id]: '' })
                        }}
                      >
                        <input
                          aria-label={`Move ${r.work_order_id} to position`}
                          placeholder="#"
                          inputMode="numeric"
                          disabled={!canReorder}
                          value={moveTo[r.work_order_id] ?? ''}
                          onChange={(e) => setMoveTo({ ...moveTo, [r.work_order_id]: e.target.value })}
                        />
                      </form>
                    </div>
                  </td>
                  <td>
                    <button
                      disabled={busy}
                      title={impactText('send_to_vendor', r.work_order_id, previews, costs)}
                      onClick={() => decide('send_to_vendor', r.work_order_id)}
                    >
                      Send to vendor
                    </button>
                    <span className="price">
                      {money(jobs[r.work_order_id]?.vendor_price ?? 0)} · {daysText(jobs[r.work_order_id]?.vendor_days ?? 0)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

// Two tables: vendor-only repairs not sent yet, and everything going to the vendor this week.
// Drag a vendor-only job down to send it this week, or back up to not send it (with the warning).
function VendorBoard({
  vendor,
  notSent,
  jobs,
  sendDay,
  previews,
  costs,
  busy,
  decide,
  onDefer,
}: {
  vendor: VendorRow[]
  notSent: HoldRow[]
  jobs: WeekResponse['jobs']
  sendDay: string
  previews: WeekResponse['previews']
  costs: Costs
  busy: boolean
  decide: Decide
  onDefer: (row: VendorRow) => void
}) {
  const [drag, setDrag] = useState<{ wo: string; from: 'waiting' | 'queue' } | null>(null)
  const [over, setOver] = useState<'waiting' | 'queue' | null>(null)
  const nextSend = addDays(sendDay, 7)

  const dragProps = (wo: string, from: 'waiting' | 'queue') => ({
    draggable: !busy,
    onDragStart: (e: DragEvent<HTMLTableRowElement>) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', wo)
      setDrag({ wo, from })
    },
    onDragEnd: () => {
      setDrag(null)
      setOver(null)
    },
  })
  const dropProps = (target: 'waiting' | 'queue') => ({
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!drag || drag.from === target) return
      e.preventDefault()
      if (over !== target) setOver(target)
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      if (drag && drag.from !== target) {
        if (target === 'queue') decide('send_to_vendor', drag.wo)
        else {
          const row = vendor.find((v) => v.work_order_id === drag.wo)
          if (row) onDefer(row)                                  // shows the turnaround warning first
        }
      }
      setDrag(null)
      setOver(null)
    },
  })
  const zone = (target: 'waiting' | 'queue') =>
    ['table-wrap', 'drop-zone', drag && drag.from !== target ? 'droppable' : '', over === target ? 'over' : ''].join(' ')

  return (
    <>
      <section>
        <SectionTitle
          title="Vendor-only repairs"
          subtitle="Jobs the shop can't do that aren't sent yet. Drag one into the queue below to send it this week."
        />
        <div className={zone('waiting')} {...dropProps('waiting')}>
          <table>
            <thead>
              <tr>
                <th aria-label="Drag" />
                <th>Order</th>
                <th>Class</th>
                <th>Job</th>
                <th className="num">Price</th>
                <th className="num">Turnaround</th>
                <th>Ready if sent this week</th>
                <th>Ready if sent next week</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {notSent.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted empty">
                    Every vendor-only repair is going out this week.
                  </td>
                </tr>
              )}
              {notSent.map((r) => {
                const j = jobs[r.work_order_id]
                const vd = j?.vendor_days ?? 0
                return (
                  <tr key={r.work_order_id} className={drag?.wo === r.work_order_id ? 'dragging' : ''} {...dragProps(r.work_order_id, 'waiting')}>
                    <td className="grip" aria-hidden>
                      ⠿
                    </td>
                    <td className="mono">{r.work_order_id}</td>
                    <td>{className(r.vehicle_class)}</td>
                    <td>{jobName(r.job_type)}</td>
                    <td className="num">{money(j?.vendor_price ?? 0)}</td>
                    <td className="num">{daysText(vd)}</td>
                    <td>
                      {day(addDays(sendDay, vd))} <span className="sub">sent {day(sendDay)}</span>
                    </td>
                    <td>
                      {day(addDays(nextSend, vd))} <span className="sub">sent {day(nextSend)}</span>
                    </td>
                    <td>
                      <button
                        disabled={busy}
                        title={impactText('send_to_vendor', r.work_order_id, previews, costs)}
                        onClick={() => decide('send_to_vendor', r.work_order_id)}
                      >
                        Send this week
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <SectionTitle
          title="Send-to-vendor queue"
          subtitle="Everything going to the vendor this week, with its send date and when it's back to rent."
        />
        <div className={zone('queue')} {...dropProps('queue')}>
          <table>
            <thead>
              <tr>
                <th aria-label="Drag" />
                <th>Order</th>
                <th>Class</th>
                <th>Job</th>
                <th className="num">Vendor price</th>
                <th className="num">Shop cost</th>
                <th className="num">Turnaround</th>
                <th>Send date</th>
                <th>Ready to rent</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {vendor.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted empty">
                    Nothing going to the vendor this week. Drag vendor-only repairs here, use “Send to vendor” in the shop
                    queue, or Optimize: Car readiness.
                  </td>
                </tr>
              )}
              {vendor.map((r) => (
                <tr
                  key={r.work_order_id}
                  className={drag?.wo === r.work_order_id ? 'dragging' : ''}
                  {...(r.in_house ? {} : dragProps(r.work_order_id, 'queue'))}
                >
                  <td className={r.in_house ? 'grip off' : 'grip'} aria-hidden>
                    ⠿
                  </td>
                  <td className="mono">{r.work_order_id}</td>
                  <td>{className(r.vehicle_class)}</td>
                  <td>
                    {jobName(r.job_type)}
                    <span className="tag">{r.in_house ? 'in-house' : 'vendor-only'}</span>
                  </td>
                  <td className="num">{money(r.vendor_price)}</td>
                  <td className="num muted">{r.in_house ? money(jobs[r.work_order_id]?.shop_cost ?? 0) : '–'}</td>
                  <td className="num">{daysText(jobs[r.work_order_id]?.vendor_days ?? 0)}</td>
                  <td>{day(r.sent_date)}</td>
                  <td>{day(r.ready_date)}</td>
                  <td>
                    {r.in_house ? (
                      <button
                        disabled={busy}
                        title={impactText('bring_to_shop', r.work_order_id, previews, costs)}
                        onClick={() => decide('bring_to_shop', r.work_order_id)}
                      >
                        Repair in house
                      </button>
                    ) : (
                      <button disabled={busy} title={impactText('hold', r.work_order_id, previews, costs)} onClick={() => onDefer(r)}>
                        Don't send
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

// Split button: the main part runs the selected goal (Savings by default); the arrow opens the choices.
function OptimizeButton({
  busy,
  current,
  options,
  onRun,
}: {
  busy: boolean
  current: number
  options: Record<Goal, OptionPreview>
  onRun: (goal: Goal) => void
}) {
  const [goal, setGoal] = useState<Goal>('savings')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  const o = options[goal]
  return (
    <div className="split" ref={ref}>
      <button
        className="btn-primary split-main"
        disabled={busy}
        title={`${GOAL_HELP[goal]}. Week cost ${money(current)} → ${money(o.total)}, ${o.car_days_short} car-days short.`}
        onClick={() => onRun(goal)}
      >
        Optimize: {GOAL_LABEL[goal]}
      </button>
      <button
        className="btn-primary split-arrow"
        disabled={busy}
        aria-label="Choose what to optimize for"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ▾
      </button>
      {open && (
        <div className="split-menu" role="menu">
          {(['savings', 'readiness'] as Goal[]).map((g) => {
            return (
              <button
                key={g}
                role="menuitem"
                className={g === goal ? 'split-item active' : 'split-item'}
                onClick={() => {
                  setGoal(g)
                  setOpen(false)
                  onRun(g)
                }}
              >
                <span className="split-title">
                  {GOAL_LABEL[g]}
                  {g === 'savings' && <span className="tag">default</span>}
                  {g === goal && (
                    <span className="split-check" aria-label="Selected">
                      ✓
                    </span>
                  )}
                </span>
                <span className="muted">{GOAL_HELP[g]}</span>
                {g === 'savings' && (
                  <span className="split-note">
                    <span className="split-note-icon" aria-hidden>
                      i
                    </span>
                    Only uses the vendor budget when it lowers the cost of the week.
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
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
                  {d.detail && 'from' in d.detail
                    ? `${String(d.detail.from).replace('hold', 'not sent')} → ${String(d.detail.to).replace('hold', 'not sent')}`
                    : d.detail && 'goal' in d.detail
                      ? GOAL_LABEL[d.detail.goal as Goal] ?? String(d.detail.goal)
                      : ''}
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

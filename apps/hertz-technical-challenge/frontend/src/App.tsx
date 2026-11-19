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
  jobs: Record<string, { vehicle_id: string; in_house: boolean; vendor_price: number; vendor_days: number }>
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
  const page = usePage()

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
        <p className="eyebrow">Fleet maintenance</p>
        <h1>Maintenance planner</h1>
        {error ? <p className="error">Couldn't load the week: {error}</p> : <p className="muted">Loading the week…</p>}
      </main>
    )
  }

  const { week, previews, decisions } = data
  const days = week.week_days
  const weekLabel = `${day(days[0])} – ${day(days[days.length - 1])}`
  const shortClasses = new Set(week.shortages.filter((c) => c.short > 0).map((c) => c.vehicle_class))
  const meta = PAGES.find((p) => p.id === page) ?? PAGES[0]
  const counts: Partial<Record<Page, number>> = {
    queue: week.shop_queue.length,
    vendor: week.vendor.length,
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
            <button className="btn-primary" disabled title="Coming next: we're agreeing the ranking rule first">
              Use suggested order
            </button>
            <button className="btn-outline" disabled={busy} onClick={() => decide('reset_to_oldest_first')}>
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
              <SectionTitle title="Cost of the week" subtitle="Shop + vendor + lost revenue, Monday to Sunday." badge={weekLabel} />
              <CostCards costs={week.costs} baseline={data.baseline_total} />
              <p className="muted assumptions">
                Shop: {data.config.shop.tech_hours_per_day} tech hrs/day, {data.config.shop.open_days.join('–')} · $
                {data.config.shop.labor_rate_per_hour}/hr · Vendor budget {money(data.config.vendor.weekly_budget)}/week
              </p>
            </section>
            <section>
              <SectionTitle title="Latest decisions" subtitle="The most recent changes to the plan." />
              <DecisionLog decisions={decisions.slice(0, 5)} />
              <a className="see-all" href="#/log">
                View the full decision log →
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
              <ShopQueue
                rows={week.shop_queue}
                previews={previews}
                costs={week.costs}
                busy={busy}
                decide={decide}
                jobs={data.jobs}
                shortClasses={shortClasses}
              />
            </section>
          </>
        )}

        {page === 'vendor' && (
          <>
            <section>
              <CostCards costs={week.costs} baseline={data.baseline_total} />
            </section>
            <section>
              <VendorList rows={week.vendor} previews={previews} costs={week.costs} busy={busy} decide={decide} />
            </section>
          </>
        )}

        {page === 'log' && (
          <section>
            <DecisionLog decisions={decisions} />
          </section>
        )}
      </main>
    </div>
  )
}

// ------------------------------------------------------------- layout ----
type Page = 'summary' | 'shortages' | 'queue' | 'vendor' | 'log'

const PAGES: { id: Page; label: string; subtitle: string }[] = [
  { id: 'summary', label: 'Summary', subtitle: 'The week at a glance.' },
  { id: 'shortages', label: 'Cars short', subtitle: 'Customers without a car, by class and day.' },
  { id: 'queue', label: 'Shop queue', subtitle: 'Worked top to bottom. Reorder jobs, or send one to the vendor.' },
  { id: 'vendor', label: 'Sent to vendor', subtitle: 'Ready to rent on the date shown. Bring a job back to repair it in house.' },
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
        <div className="bar" aria-hidden>
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

const PREVIEW_KEY: Record<string, Assignment> = { send_to_vendor: 'vendor', bring_to_shop: 'shop' }
const ACTION_TEXT: Record<string, string> = {
  send_to_vendor: 'Send %s to the vendor',
  bring_to_shop: 'Repair %s in house',
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
}) {
  const [moveTo, setMoveTo] = useState<Record<string, string>>({})

  // --- Filters and sort: they change what's shown, never the plan itself ----
  const [search, setSearch] = useState('')
  const [cls, setCls] = useState('all')
  const [job, setJob] = useState('all')
  const [ready, setReady] = useState<ReadyFilter>('all')
  const [onlyShort, setOnlyShort] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'position', desc: false })

  const classes = useMemo(() => [...new Set(rows.map((r) => r.vehicle_class))].sort(), [rows])
  const jobTypes = useMemo(() => [...new Set(rows.map((r) => r.job_type))].sort(), [rows])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = rows.filter(
      (r) =>
        (!q || r.work_order_id.toLowerCase().includes(q) || (jobs[r.work_order_id]?.vehicle_id ?? '').toLowerCase().includes(q)) &&
        (cls === 'all' || r.vehicle_class === cls) &&
        (job === 'all' || r.job_type === job) &&
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
  }, [rows, jobs, search, cls, job, ready, onlyShort, shortClasses, sort])

  const filtered = shown.length !== rows.length
  const queueOrder = sort.key === 'position' && !sort.desc
  const canReorder = !busy && queueOrder
  const clear = () => {
    setSearch('')
    setCls('all')
    setJob('all')
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
      let to = dropAt.after ? dropAt.position + 1 : dropAt.position
      if (from < to) to -= 1
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
                    {shortClasses.has(r.vehicle_class) && <span className="tag short-tag">short</span>}
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
                    <span className="price">{money(jobs[r.work_order_id]?.vendor_price ?? 0)}</span>
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

function VendorList({
  rows,
  previews,
  costs,
  busy,
  decide,
}: {
  rows: VendorRow[]
  previews: WeekResponse['previews']
  costs: Costs
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
                {r.in_house ? (
                  <button disabled={busy} title={impactText('bring_to_shop', r.work_order_id, previews, costs)} onClick={() => decide('bring_to_shop', r.work_order_id)}>
                    Repair in house
                  </button>
                ) : (
                  <span className="muted">Vendor only</span>
                )}
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

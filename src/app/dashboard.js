// Parent dashboard: per-child weekly study time, quiz accuracy, last studied,
// and a live "Active now" presence indicator polled from active_sessions.
import { requireSession, getFamily, signOut, setActiveChild } from './auth.js'
import { getDashboardData, getActiveSessions, refreshChildCode } from './api.js'
import { $, escapeHtml, relativeDay, initials, tintFor, setStatus, loading } from './ui.js'

const STALE_MS = 2 * 60 * 1000 // matches the 2-minute staleness rule in the migration
const FREEZE_MS = 10 * 1000 // study page pings every 5s while active and stops while paused; > 10s means paused

const content = $('#content')
$('[data-signout]')?.addEventListener('click', signOut)

async function main() {
  const session = await requireSession()
  if (!session) return
  const role = session.user.user_metadata?.role
  console.log('session.user.user_metadata:', session.user.user_metadata)
  if (role && role !== 'parent' && role !== 'self') {
    location.replace('/app/child.html')
    return
  }
  try {
    await getFamily() // bootstrap the family row on first login
    const children = await getDashboardData()
    const presence = await fetchPresence()
    render(children, presence)
    startPolling()
  } catch (err) {
    content.innerHTML = `<div class="banner banner--error">Couldn't load your dashboard: ${escapeHtml(err.message)}</div>`
  }
}

/** Map of child_id -> { startedAt, pausedMs, lastPing }, for sessions pinged within the last 2 minutes. */
async function fetchPresence() {
  try {
    const rows = await getActiveSessions()
    console.log('fetchPresence: active_sessions rows =', rows)
    const now = Date.now()
    const map = new Map()
    for (const row of rows) {
      if (now - new Date(row.last_ping).getTime() <= STALE_MS) {
        map.set(row.child_id, { startedAt: row.started_at, pausedMs: row.paused_ms || 0, lastPing: row.last_ping })
      }
    }
    console.log('fetchPresence: resulting map =', map)
    return map
  } catch (err) {
    console.error('fetchPresence failed:', err) // presence is a nice-to-have; never blocks the rest of the dashboard
    return new Map()
  }
}

function startPolling() {
  // Refresh active/inactive state every 30s without re-fetching the rest of
  // the dashboard's stats (those don't need to be this fresh).
  setInterval(async () => applyPresence(await fetchPresence()), 30000)
  // Cheap per-second tick so the "Active now" timers count up smoothly.
  setInterval(updateTimers, 1000)
}

function render(children, presence) {
  if (!children.length) {
    content.innerHTML = `
      <div class="empty">
        <div class="empty__icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>
        </div>
        <h2 style="margin-bottom:6px">Add your first child</h2>
        <p class="muted" style="margin-bottom:18px">Create a profile to start uploading notes and tracking progress.</p>
        <a class="btn btn-primary" href="/app/add-child.html">+ Add a child</a>
      </div>`
    return
  }

  const cards = children.map((c) => renderCard(c, presence.get(c.id))).join('')
  content.innerHTML = `<div class="child-grid">${cards}</div>`

  content.querySelectorAll('[data-show-code]').forEach((btn) => {
    btn.addEventListener('click', () => handleToggleCode(btn))
  })
  content.querySelectorAll('[data-refresh-code]').forEach((btn) => {
    btn.addEventListener('click', () => handleRefreshCode(btn))
  })

  updateTimers()
}

function renderCard(c, presence) {
  const tint = tintFor(c.name)
  const week = c.weekMinutes ? `${c.weekMinutes}m` : '0m'
  const acc = c.accuracy == null ? '—' : `${c.accuracy}%`
  const timerAttr = presence
    ? ` data-started-at="${escapeHtml(presence.startedAt)}" data-paused-ms="${presence.pausedMs}" data-last-ping="${escapeHtml(presence.lastPing)}"`
    : ''
  return `
      <article class="card child-card" data-child-id="${c.id}">
        <div class="child-card__top">
          <span class="avatar" style="background:${tint}">${escapeHtml(initials(c.name))}</span>
          <div class="child-card__identity">
            <div class="child-card__name-row">
              <span class="child-card__name">${escapeHtml(c.name)}</span>
              <button class="btn btn-ghost btn-sm" data-show-code type="button">Show code</button>
            </div>
            <div class="child-card__grade">${c.grade ? 'Grade ' + escapeHtml(c.grade) : 'Learner'}</div>
          </div>
        </div>
        <p class="form-status" data-code-status role="status" aria-live="polite"></p>
        <div class="code-reveal-inline hidden" data-code-area>
          <div class="code-pill-row">
            <span class="code-pill" data-code-pill></span>
            <button class="code-refresh-btn" data-refresh-code type="button" title="Code not working? Generate a new one" aria-label="Generate a new code">↻</button>
          </div>
          <p class="code-pill__note">Share this code with your child. It changes each time you view it.</p>
        </div>
        <div class="presence${presence ? '' : ' hidden'}" data-presence>
          <span class="presence__dot" aria-hidden="true"></span>
          <span>Active now</span>
          <span class="presence__timer"${timerAttr}>0:00</span>
        </div>
        <div class="stat-mini-row">
          <div class="stat-mini"><div class="stat-mini__label">This week</div><div class="stat-mini__value">${week}</div></div>
          <div class="stat-mini"><div class="stat-mini__label">Quiz accuracy</div><div class="stat-mini__value">${acc}</div></div>
          <div class="stat-mini"><div class="stat-mini__label">Last studied</div><div class="stat-mini__value" style="font-size:.95rem">${escapeHtml(relativeDay(c.lastStudied))}</div></div>
        </div>

        <a class="child-card__analytics-link" href="/app/analytics.html?child=${c.id}">Analytics →</a>
      </article>`
}

/** "Show code" generates + reveals a fresh code and flips the button to "Hide";
 *  "Hide" just collapses the area again — no new code is generated. */
async function handleToggleCode(btn) {
  const card = btn.closest('[data-child-id]')
  const areaEl = card.querySelector('[data-code-area]')

  if (btn.textContent === 'Hide') {
    areaEl.classList.add('hidden')
    btn.textContent = 'Show code'
    return
  }

  const childId = card.dataset.childId
  const statusEl = card.querySelector('[data-code-status]')
  const pillEl = card.querySelector('[data-code-pill]')

  setStatus(statusEl, '')
  const restore = loading(btn, 'Generating…')
  try {
    const code = await refreshChildCode(childId)
    restore()
    pillEl.textContent = code
    areaEl.classList.remove('hidden')
    btn.textContent = 'Hide'
  } catch (err) {
    restore()
    setStatus(statusEl, err.message || 'Could not generate a code. Try again.', 'error')
  }
}

/** Refresh icon next to the revealed code: rotates the code in place without touching the Show/Hide button state. */
async function handleRefreshCode(btn) {
  const card = btn.closest('[data-child-id]')
  const childId = card.dataset.childId
  const statusEl = card.querySelector('[data-code-status]')
  const pillEl = card.querySelector('[data-code-pill]')

  setStatus(statusEl, '')
  btn.disabled = true
  try {
    const code = await refreshChildCode(childId)
    pillEl.textContent = code
  } catch (err) {
    setStatus(statusEl, err.message || 'Could not generate a code. Try again.', 'error')
  } finally {
    btn.disabled = false
  }
}

/** Updates each card's presence dot/timer in place — never re-renders the grid. */
function applyPresence(presence) {
  content.querySelectorAll('[data-child-id]').forEach((card) => {
    const presenceEl = card.querySelector('[data-presence]')
    if (!presenceEl) return
    const timerEl = presenceEl.querySelector('.presence__timer')
    const entry = presence.get(card.dataset.childId)
    if (entry) {
      presenceEl.classList.remove('hidden')
      timerEl.dataset.startedAt = entry.startedAt
      timerEl.dataset.pausedMs = entry.pausedMs
      timerEl.dataset.lastPing = entry.lastPing
    } else {
      presenceEl.classList.add('hidden')
      delete timerEl.dataset.startedAt
      delete timerEl.dataset.pausedMs
      delete timerEl.dataset.lastPing
    }
  })
  updateTimers()
}

function updateTimers() {
  content.querySelectorAll('.presence__timer[data-started-at]').forEach((el) => {
    if (el.dataset.lastPing && Date.now() - new Date(el.dataset.lastPing).getTime() > FREEZE_MS) {
      return // child paused or went inactive — leave the displayed time as-is instead of counting up
    }
    const pausedMs = Number(el.dataset.pausedMs) || 0
    const elapsedMs = Date.now() - new Date(el.dataset.startedAt).getTime() - pausedMs
    const s = Math.max(0, Math.floor(elapsedMs / 1000))
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  })
}

main()

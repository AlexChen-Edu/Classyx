// Parent dashboard: per-child weekly study time, quiz accuracy, last studied,
// and a live "Active now" presence indicator polled from active_sessions.
import { requireSession, getFamily, signOut, setActiveChild } from './auth.js'
import { getDashboardData, getActiveSessions } from './api.js'
import { $, escapeHtml, initials, tintFor, relativeDay, renderStreakBadge } from './ui.js'

const STALE_MS = 2 * 60 * 1000 // matches the 2-minute staleness rule in the migration

const content = $('#content')

async function main() {
  const session = await requireSession()
  if (!session) return
  const role = session.user.user_metadata?.role
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
    if (err.deactivated) {
      await signOut()
      return
    }
    content.innerHTML = `<div class="banner banner--error">Couldn't load your dashboard: ${escapeHtml(err.message)}</div>`
  }
}

/** Set of child_ids with a session pinged within the last 2 minutes. */
async function fetchPresence() {
  try {
    const rows = await getActiveSessions()
    const now = Date.now()
    const set = new Set()
    for (const row of rows) {
      if (now - new Date(row.last_ping).getTime() <= STALE_MS) set.add(row.child_id)
    }
    return set
  } catch (err) {
    console.error('fetchPresence failed:', err) // presence is a nice-to-have; never blocks the rest of the dashboard
    return new Set()
  }
}

function startPolling() {
  // Refresh active/inactive state every 30s without re-fetching the rest of
  // the dashboard's stats (those don't need to be this fresh).
  setInterval(async () => applyPresence(await fetchPresence()), 30000)
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

  const cards = children.map((c) => renderCard(c, presence.has(c.id))).join('')
  content.innerHTML = `<div class="child-grid">${cards}</div>`

}

/**
 * Apple-Activity-style ring: today_minutes / daily_goal_minutes, capped at 100%.
 * While the goal isn't met yet, the ring pulses and the caption shows minutes
 * remaining instead of a static label — an open loop (Zeigarnik effect) that
 * keeps the parent watching this card until it closes. Once met, the pulse
 * stops and the fill gets a one-shot green flash instead.
 */
function renderGoalRing(todayMinutes, goalMinutes) {
  const r = 19
  const circumference = 2 * Math.PI * r
  const pct = goalMinutes > 0 ? Math.min(100, Math.round((todayMinutes / goalMinutes) * 100)) : 0
  const offset = circumference * (1 - pct / 100)
  const met = pct >= 100
  return `
    <div class="goal-ring-wrap goal-ring-wrap--sm">
      <svg class="goal-ring${met ? '' : ' goal-ring--pulsing'}" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="${pct}% of today's study goal">
        <circle class="goal-ring__track" cx="24" cy="24" r="${r}" />
        <circle class="goal-ring__fill${met ? ' goal-ring__fill--flash' : ''}" cx="24" cy="24" r="${r}"
          stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />
      </svg>
      <span class="goal-ring__center goal-ring__center--sm">${pct}%</span>
    </div>`
}

/**
 * Continuous green->amber->red hue for a quiz-accuracy percentage. Piecewise-linear
 * across control points (not stepped buckets) so every percentage gets its own
 * shade — 85% and 95% both read "good" but aren't identical.
 */
function accuracyHue(pct) {
  const p = Math.max(0, Math.min(100, pct))
  const stops = [[0, 4], [50, 4], [70, 45], [90, 141], [100, 141]]
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, h0] = stops[i]
    const [p1, h1] = stops[i + 1]
    if (p <= p1) return h0 + (h1 - h0) * ((p - p0) / (p1 - p0))
  }
  return stops.at(-1)[1]
}

function accuracyColor(pct) {
  return `hsl(${accuracyHue(pct).toFixed(0)}, 72%, 44%)`
}

function accuracyLabel(pct) {
  if (pct >= 90) return 'Excellent'
  if (pct >= 75) return 'Good'
  if (pct >= 60) return 'Fair'
  if (pct >= 50) return 'Needs practice'
  return 'Struggling'
}

function renderStats(c) {
  const accuracyHtml = c.accuracy == null
    ? `<span class="child-card__stat-value">—</span>`
    : `<span class="child-card__stat-value" style="color:${accuracyColor(c.accuracy)}">${c.accuracy}%</span>
       <span class="child-card__stat-sub">${accuracyLabel(c.accuracy)}</span>`

  return `
    <div class="child-card__stats">
      <div class="child-card__stat">
        <span class="child-card__stat-label">Quiz accuracy</span>
        ${accuracyHtml}
      </div>
      <div class="child-card__stat">
        <span class="child-card__stat-label">Last studied</span>
        <span class="child-card__stat-value">${relativeDay(c.lastStudied)}</span>
      </div>
      <div class="child-card__stat">
        <span class="child-card__stat-label">Streak</span>
        ${c.streak > 0 ? renderStreakBadge(c.streak) : `<span class="child-card__stat-value">0 days</span>`}
      </div>
    </div>`
}

function renderCard(c, isActive) {
  const tint = tintFor(c.name)
  const neverStudied = !c.lastStudied // true the moment a child profile is created, until their first session lands
  const goalMinutes = c.daily_goal_minutes || 30
  const todayMinutes = c.todayMinutes || 0
  const met = todayMinutes >= goalMinutes
  const minutesToGo = Math.max(0, Math.ceil(goalMinutes - todayMinutes))

  return `
      <article class="card child-card${neverStudied ? ' child-card--waiting' : ''}" data-child-id="${c.id}">
        <div class="child-card__top">
          <span class="avatar" style="background:${tint}">${escapeHtml(initials(c.name))}</span>
          <div class="child-card__identity">
            <span class="child-card__name">${escapeHtml(c.name)}</span>
            <div class="child-card__grade">${c.grade ? 'Grade ' + escapeHtml(c.grade) : 'Learner'}</div>
          </div>
          ${!neverStudied ? renderGoalRing(todayMinutes, goalMinutes) : ''}
        </div>

        ${neverStudied ? `
        <div class="waiting-banner">
          <span class="waiting-banner__icon" aria-hidden="true">👋</span>
          <div>
            <p class="waiting-banner__title">Ready when ${escapeHtml(c.name)} is</p>
            <p class="waiting-banner__text">Get ${escapeHtml(c.name)}'s sign-in code from Settings, then have them enter it at the student sign-in screen to start their first session.</p>
          </div>
        </div>` : `
        <div class="child-card__meta-row">
          <span class="child-card__goal-text${met ? ' is-complete' : ''}">${met ? '✓ Goal met!' : `${minutesToGo} min to go`}</span>
          <div class="presence${isActive ? '' : ' hidden'}" data-presence>
            <span class="presence__dot" aria-hidden="true"></span>
            <span>Active now</span>
          </div>
        </div>

        ${renderStats(c)}

        <a class="child-card__analytics-link" href="/app/analytics.html?child=${c.id}">Analytics →</a>`}
      </article>`
}

/** Updates each card's presence dot in place — never re-renders the grid. */
function applyPresence(presence) {
  content.querySelectorAll('[data-child-id]').forEach((card) => {
    const presenceEl = card.querySelector('[data-presence]')
    if (!presenceEl) return
    presenceEl.classList.toggle('hidden', !presence.has(card.dataset.childId))
  })
}

main()

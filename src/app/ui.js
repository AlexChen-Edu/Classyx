// Small DOM + formatting helpers shared across the app pages.

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/** Escape user/AI text before inserting into innerHTML. */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

/** Show a status message in a [data-status] element with success/error state. */
export function setStatus(el, message, state = '') {
  if (!el) return
  el.textContent = message || ''
  if (state) el.dataset.state = state
  else el.removeAttribute('data-state')
}

/**
 * Turns an error into UI-safe text: app-level errors we threw ourselves
 * (e.g. "Invalid or expired code") are already written for a parent/student
 * to read, so they pass through; anything that looks like a raw Postgres/
 * PostgREST/network error (constraint names, error codes, stack-shaped text)
 * is swapped for the given fallback instead of leaking internals.
 */
const TECHNICAL_ERROR_RE = /violates|constraint|permission denied|JWT|PGRST|row-level security|relation "|column "|fetch|network|22023|42501|23505|\[object|undefined|null$/i

export function friendlyMessage(err, fallback) {
  const m = (err?.message || '').trim()
  if (!m || TECHNICAL_ERROR_RE.test(m)) return fallback
  return m
}

/** Toggle a button into a loading state and back. Returns a restore fn. */
export function loading(btn, label = 'Working…') {
  if (!btn) return () => {}
  const original = btn.innerHTML
  btn.disabled = true
  btn.dataset.loading = 'true'
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${escapeHtml(label)}`
  return () => {
    btn.disabled = false
    btn.removeAttribute('data-loading')
    btn.innerHTML = original
  }
}

/** Friendly "3 days ago" / "Today" style date. */
export function relativeDay(iso) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  const today = new Date()
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** 134 -> "2h 14m"; 45 -> "45m"; 0/null -> "0m". */
export function formatMinutes(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes || 0))
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h === 0) return `${rem}m`
  if (rem === 0) return `${h}h`
  return `${h}h ${rem}m`
}

/** ISO string -> "Jun 24, 3:45 PM"; null -> "Never". */
export function formatDateTime(iso) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date}, ${time}`
}

export function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'
}

/** Stable-ish color from a string, for avatar tints. */
export function tintFor(name) {
  const palette = ['#2d6a4f', '#1f9d6b', '#c9a13b', '#a96a12', '#3c4760']
  let h = 0
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

/** Current consecutive days studied, counting back from today. Not period-scoped — a streak is a global, ongoing thing. */
export function computeStreak(sessions) {
  const days = new Set(sessions.map((s) => new Date(s.started_at).toDateString()))
  const cursor = new Date()
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1) // hasn't studied yet today — don't zero the streak for that alone
  let streak = 0
  while (days.has(cursor.toDateString())) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/**
 * 0 days -> '' (nothing shown); 1-3 orange, 4-6 red, 7-13 blue, 14-20 purple,
 * 21+ gold with a pulse animation. Tiers/colors defined in app.css
 * (.streak-badge--*) — the emoji itself can't be recolored directly, so each
 * tier retints the native 🔥 via a CSS filter (hue-rotate/saturate) on the
 * .streak-badge__emoji span.
 */
export function renderStreakBadge(streak) {
  if (streak <= 0) return ''
  let tier
  if (streak <= 3) tier = 'orange'
  else if (streak <= 6) tier = 'red'
  else if (streak <= 13) tier = 'blue'
  else if (streak <= 20) tier = 'purple'
  else tier = 'gold'
  return `
    <div class="streak-badge streak-badge--${tier}">
      <span class="streak-badge__emoji" aria-hidden="true">🔥</span>
      <span>${streak}-day streak</span>
    </div>`
}

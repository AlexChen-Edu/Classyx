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

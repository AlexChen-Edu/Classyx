// Per-child analytics: This Week / This Month stats computed client-side from
// one bulk fetch (study_sessions + quiz_results), so switching tabs is instant
// and never re-queries. Reached from the dashboard's "Analytics →" link as
// /app/analytics.html?child=CHILD_ID.
//
// quiz_results has no `subject` column (only flashcard_id/correct/answered_at),
// so there is no real per-subject quiz accuracy to report — the "low accuracy"
// recommendation below names the most-studied subject alongside the real
// overall accuracy, rather than fabricating a per-subject number that isn't
// actually in the data.
import { requireSession, signOut } from './auth.js'
import { getChildAnalytics } from './api.js'
import { $, $$, escapeHtml, formatMinutes, formatDateTime, computeStreak, renderStreakBadge } from './ui.js'

$('[data-signout]')?.addEventListener('click', signOut)

const nameEl = $('#child-name')
const gradeEl = $('#child-grade')
const streakSlot = $('#streak-badge-slot')
const contentEl = $('#analytics-content')
const tabs = document.querySelectorAll('[data-period]')

let dataset = null // { child, sessions, quizzes } — the full, unfiltered fetch
let period = 'week'
let subjectFilter = 'all'

async function main() {
  const session = await requireSession()
  if (!session) return
  const role = session.user.user_metadata?.role
  if (role && role !== 'parent' && role !== 'self') {
    location.replace('/app/child.html')
    return
  }

  const childId = new URLSearchParams(location.search).get('child')
  if (!childId) {
    showError("No child specified. Go back to the dashboard and pick a child's Analytics link.")
    return
  }

  try {
    dataset = await getChildAnalytics(childId)
  } catch (err) {
    showError(err.message || 'Could not load analytics for this child.')
    return
  }

  nameEl.textContent = dataset.child.name
  gradeEl.textContent = dataset.child.grade ? `Grade ${dataset.child.grade}` : 'Learner'
  streakSlot.innerHTML = renderStreakBadge(computeStreak(dataset.sessions))

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      period = tab.dataset.period
      subjectFilter = 'all' // a subject list from the old period may not apply to the new one
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)))
      render()
    })
  })

  render()
}

function showError(message) {
  contentEl.innerHTML = `<div class="banner banner--error">${escapeHtml(message)}</div>`
}

// --- Period math -------------------------------------------------------------
function periodBounds(p) {
  const now = new Date()
  if (p === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0) // last day of this month
    return { start, end }
  }
  // Monday-to-Sunday of the current week (matches the dashboard's "This week" math).
  const day = (now.getDay() + 6) % 7
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return { start, end }
}

// --- Stats (pure functions over the already-fetched dataset) ----------------
function computeStats({ sessions, quizzes }, start, end) {
  const periodSessions = sessions.filter((s) => {
    const d = new Date(s.started_at)
    return d >= start && d <= end
  })
  const periodQuizzes = quizzes.filter((q) => new Date(q.answered_at) >= start)

  const totalMinutes = periodSessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0)
  const activeDays = new Set(periodSessions.map((s) => new Date(s.started_at).toDateString())).size

  const flashcardsReviewed = periodQuizzes.length
  const correct = periodQuizzes.filter((q) => q.correct).length
  const accuracy = periodQuizzes.length ? Math.round((correct / periodQuizzes.length) * 100) : null

  // Subjects + time-per-subject: sourced from study_sessions (subject +
  // duration_minutes together) rather than the uploads table — uploads has
  // no duration field, so it can't answer "time spent on each" on its own.
  const subjectMinutes = new Map()
  for (const s of periodSessions) {
    const subj = s.subject || 'General'
    subjectMinutes.set(subj, (subjectMinutes.get(subj) || 0) + (s.duration_minutes || 0))
  }
  const subjects = [...subjectMinutes.entries()]
    .filter(([, minutes]) => minutes > 0)
    .sort((a, b) => b[1] - a[1])

  return { totalMinutes, activeDays, flashcardsReviewed, accuracy, subjects, periodSessions }
}

/** Most recent session overall, not period-scoped — "last active" should be true regardless of which tab is open. */
function lastActive(sessions) {
  return sessions.length ? sessions[sessions.length - 1].started_at : null
}

// --- Line graph, daily totals (pure SVG, no chart library) -----------------
function buildDailySeries(sessions, start, end, subject) {
  const days = []
  const cursor = new Date(start)
  while (cursor <= end) {
    days.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  const minutesByDay = new Map(days.map((d) => [d.toDateString(), 0]))
  for (const s of sessions) {
    const d = new Date(s.started_at)
    if (d < start || d > end) continue
    if (subject !== 'all' && (s.subject || 'General') !== subject) continue
    const key = d.toDateString()
    if (minutesByDay.has(key)) minutesByDay.set(key, minutesByDay.get(key) + (s.duration_minutes || 0))
  }
  return days.map((d) => ({ date: d, minutes: minutesByDay.get(d.toDateString()) || 0 }))
}

/** "45 min" / "2h 14m" — the bold green line in the custom hover tooltip. */
function formatTooltipMinutes(minutes) {
  const m = Math.max(0, Math.round(minutes || 0))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

function renderChart(series, period) {
  const W = 600
  const H = 220
  const padL = 36
  const padR = 12
  const padT = 14
  const padB = 28
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const maxMinutes = Math.max(30, ...series.map((p) => p.minutes)) // floor of 30 keeps a flat week from looking like a flatline at the very top
  const stepX = series.length > 1 ? plotW / (series.length - 1) : 0
  const x = (i) => padL + i * stepX
  const y = (m) => padT + plotH - (m / maxMinutes) * plotH

  const points = series.map((p, i) => [x(i), y(p.minutes)])
  const linePath = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${x(series.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`

  const gridFractions = [0, 0.25, 0.5, 0.75, 1]
  const gridLines = gridFractions.filter((f) => f > 0).map((f) => {
    const gy = padT + plotH * f
    return `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" />`
  }).join('')

  // Y-axis minute labels, rounded to the nearest 5 — matches the same gridlines.
  const yLabels = gridFractions.map((f) => {
    const value = Math.round((maxMinutes * (1 - f)) / 5) * 5
    const gy = padT + plotH * f
    return `<text x="${(padL - 8).toFixed(1)}" y="${(gy + 3).toFixed(1)}">${value}</text>`
  }).join('')

  const dots = points.map(([px, py], i) => {
    const dayLabel = period === 'week'
      ? series[i].date.toLocaleDateString(undefined, { weekday: 'long' })
      : series[i].date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const minutesLabel = formatTooltipMinutes(series[i].minutes)
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" data-day="${escapeHtml(dayLabel)}" data-minutes="${escapeHtml(minutesLabel)}"></circle>`
  }).join('')

  // Thin out x-axis labels for longer (month) series so they don't overlap.
  const labelEvery = period === 'month' ? Math.ceil(series.length / 7) : 1
  const labels = series.map((p, i) => {
    if (i % labelEvery !== 0 && i !== series.length - 1) return ''
    const text = period === 'week'
      ? p.date.toLocaleDateString(undefined, { weekday: 'short' })
      : p.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `<text x="${x(i).toFixed(1)}" y="${H - 8}">${text}</text>`
  }).join('')

  return `
    <svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Study minutes per day for the selected period">
      <defs>
        <linearGradient id="analyticsAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop class="trend__stop-top" offset="0%" />
          <stop class="trend__stop-bottom" offset="100%" />
        </linearGradient>
      </defs>
      <g class="trend__grid">${gridLines}</g>
      <path class="trend__area" style="fill:url(#analyticsAreaFill)" d="${areaPath}" />
      <path class="trend__line" d="${linePath}" />
      <g class="trend__dots">${dots}</g>
      <g class="trend__y-labels">${yLabels}</g>
      <g class="trend__labels">${labels}</g>
    </svg>`
}

// --- Custom chart tooltip (instant show/hide, no native title delay) -------
const chartTooltip = $('#chart-tooltip')
const chartTooltipDay = chartTooltip?.querySelector('.chart-tooltip__day')
const chartTooltipMinutes = chartTooltip?.querySelector('.chart-tooltip__minutes')

function attachChartTooltip() {
  if (!chartTooltip) return
  $$('.trend__dots circle', contentEl).forEach((circle) => {
    circle.addEventListener('mouseenter', () => {
      chartTooltipDay.textContent = circle.dataset.day
      chartTooltipMinutes.textContent = circle.dataset.minutes
      chartTooltip.hidden = false
      const dotRect = circle.getBoundingClientRect()
      const tipRect = chartTooltip.getBoundingClientRect()
      chartTooltip.style.left = `${dotRect.left + dotRect.width / 2 - tipRect.width / 2 + window.scrollX}px`
      chartTooltip.style.top = `${dotRect.top - tipRect.height - 10 + window.scrollY}px`
    })
    circle.addEventListener('mouseleave', () => {
      chartTooltip.hidden = true
    })
  })
}

// --- Recommendations (generated from real data) -----------------------------
function buildRecommendations({ stats, streak, sessions, periodLabel }) {
  const recs = []
  const topSubject = stats.subjects[0]?.[0]

  if (stats.accuracy != null && stats.accuracy < 70) {
    recs.push({
      text: `Consider reviewing${topSubject ? ` ${topSubject}` : ''} flashcards — accuracy is ${stats.accuracy}%, below the 70% mark.`,
      priority: 1,
    })
  }

  const last = lastActive(sessions)
  const daysSince = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null
  if (daysSince != null && daysSince >= 3) {
    recs.push({ text: `No sessions in ${daysSince} days — try a short 10 minute review to keep things fresh.`, priority: 2 })
  }

  if (stats.subjects.length >= 1) {
    const totalSubjectMinutes = stats.subjects.reduce((sum, [, m]) => sum + m, 0)
    const share = totalSubjectMinutes ? stats.subjects[0][1] / totalSubjectMinutes : 0
    if (stats.subjects.length >= 2 && share >= 0.6) {
      recs.push({ text: `You've focused mostly on ${topSubject} ${periodLabel} — don't forget other subjects.`, priority: 3 })
    }
  }

  if (streak >= 7) {
    recs.push({ text: `Great streak — ${streak} days! Keep it going tomorrow.`, priority: 0 })
  }

  if (!recs.length) {
    recs.push({ text: "Nice, steady progress — keep up the consistent practice.", priority: 4 })
  } else if (recs.length === 1) {
    recs.push({ text: `${formatMinutes(stats.totalMinutes)} studied ${periodLabel} across ${stats.activeDays} active day${stats.activeDays === 1 ? '' : 's'} — solid effort.`, priority: 5 })
  }

  return recs.sort((a, b) => a.priority - b.priority).slice(0, 3)
}

const LIGHTBULB_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .9 1.7l.1.5h5.2l.1-.5c.1-.7.4-1.3.9-1.7A6 6 0 0 0 12 3Z"/></svg>`

function renderRecommendations(recs) {
  return `
    <div class="card">
      <h3 style="font-size:1rem;margin-bottom:0.75rem">Recommendations</h3>
      <div class="recommend-list">
        ${recs.map((r) => `
          <div class="recommend-card card">
            <span class="recommend-card__icon" aria-hidden="true">${LIGHTBULB_SVG}</span>
            <p class="recommend-card__text">${escapeHtml(r.text)}</p>
          </div>`).join('')}
      </div>
    </div>`
}

// --- Render -------------------------------------------------------------------
function render() {
  if (chartTooltip) chartTooltip.hidden = true // the chart markup is about to be torn down and rebuilt
  const { start, end } = periodBounds(period)
  const stats = computeStats(dataset, start, end)
  const streak = computeStreak(dataset.sessions)
  const last = lastActive(dataset.sessions)
  const maxSubjectMinutes = stats.subjects.length ? stats.subjects[0][1] : 0
  const periodLabel = period === 'week' ? 'this week' : 'this month'

  const subjectRows = stats.subjects.length
    ? stats.subjects.map(([subject, minutes]) => {
        const pct = maxSubjectMinutes ? Math.round((minutes / maxSubjectMinutes) * 100) : 0
        return `
          <div class="subject-row">
            <div class="subject-row__top"><span>${escapeHtml(subject)}</span><span>${formatMinutes(minutes)}</span></div>
            <div class="bar"><span style="width:${pct}%"></span></div>
          </div>`
      }).join('')
    : `<p class="muted">No subjects studied in this period yet.</p>`

  // Subject filter is scoped to whichever subjects appear in this period.
  if (!stats.subjects.some(([s]) => s === subjectFilter)) subjectFilter = 'all'
  const filterOptions = [`<option value="all">All subjects</option>`]
    .concat(stats.subjects.map(([s]) => `<option value="${escapeHtml(s)}"${s === subjectFilter ? ' selected' : ''}>${escapeHtml(s)}</option>`))
    .join('')

  const series = buildDailySeries(dataset.sessions, start, end, subjectFilter)
  const chartHtml = stats.subjects.length
    ? renderChart(series, period)
    : `<div class="chart-empty">No study sessions ${periodLabel} yet.</div>`

  const recs = buildRecommendations({ stats, streak, sessions: dataset.sessions, periodLabel })

  contentEl.innerHTML = `
    <div class="analytics-top-row">
      <div class="card">
        <div class="chart-card__head">
          <h3>Study time ${period === 'week' ? 'this week' : 'this month'}</h3>
          ${stats.subjects.length > 1 ? `<select class="subject-filter" id="subject-filter">${filterOptions}</select>` : ''}
        </div>
        ${chartHtml}
      </div>
      ${renderRecommendations(recs)}
    </div>

    <div class="analytics-grid">
      <article class="card analytics-card">
        <span class="analytics-card__label">Study time</span>
        <span class="analytics-card__value">${formatMinutes(stats.totalMinutes)}</span>
      </article>
      <article class="card analytics-card">
        <span class="analytics-card__label">Days active</span>
        <span class="analytics-card__value">${stats.activeDays}</span>
      </article>
      <article class="card analytics-card">
        <span class="analytics-card__label">Study streak</span>
        <span class="analytics-card__value">${streak} ${streak === 1 ? 'day' : 'days'}</span>
      </article>
      <article class="card analytics-card">
        <span class="analytics-card__label">Flashcards reviewed</span>
        <span class="analytics-card__value">${stats.flashcardsReviewed}</span>
      </article>
      <article class="card analytics-card">
        <span class="analytics-card__label">Quiz accuracy</span>
        <span class="analytics-card__value">${stats.accuracy == null ? '—' : `${stats.accuracy}%`}</span>
      </article>
      <article class="card analytics-card">
        <span class="analytics-card__label">Last active</span>
        <span class="analytics-card__value" style="font-size:1.1rem">${escapeHtml(formatDateTime(last))}</span>
      </article>
      <article class="card analytics-card analytics-card--wide">
        <span class="analytics-card__label">Subjects studied</span>
        <div class="subject-list">${subjectRows}</div>
      </article>
    </div>`

  $('#subject-filter')?.addEventListener('change', (e) => {
    subjectFilter = e.target.value
    render()
  })

  attachChartTooltip()
}

main()

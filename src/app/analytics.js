// Per-child analytics: This Week / This Month stats computed client-side from
// one bulk fetch (study_sessions + quiz_results), so switching tabs is instant
// and never re-queries. Reached from the dashboard's "Analytics →" link as
// /app/analytics.html?child=CHILD_ID.
//
// quiz_results has no `subject` column directly, but each result links to a
// flashcard -> upload -> subject, so api.js embeds that chain to get a real
// per-subject mastery %. A quiz result whose flashcard/upload was deleted (or
// never had a subject) has no resolvable subject and is excluded from the
// per-subject mastery map, falling back to "—" for that subject below.
import { requireSession, signOut } from './auth.js'
import { getChildAnalytics } from './api.js'
import {
  $, escapeHtml, formatMinutes, computeStreak, renderStreakBadge,
} from './ui.js'

$('[data-signout]')?.addEventListener('click', signOut)

const nameEl = $('#child-name')
const gradeEl = $('#child-grade')
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

/** The immediately preceding period of the same length — powers "vs last week/month". */
function previousPeriodBounds(p, start) {
  if (p === 'month') {
    const prevStart = new Date(start.getFullYear(), start.getMonth() - 1, 1)
    const prevEnd = new Date(start.getFullYear(), start.getMonth(), 0)
    return { start: prevStart, end: prevEnd }
  }
  const prevStart = new Date(start)
  prevStart.setDate(prevStart.getDate() - 7)
  const prevEnd = new Date(start)
  prevEnd.setDate(prevEnd.getDate() - 1)
  return { start: prevStart, end: prevEnd }
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

  return { totalMinutes, activeDays, flashcardsReviewed, accuracy, subjects, periodSessions, subjectAccuracy: computeSubjectAccuracy(periodQuizzes) }
}

/** subject -> mastery % (null if no quiz results resolve to that subject). */
function computeSubjectAccuracy(quizzes) {
  const bySubject = new Map()
  for (const q of quizzes) {
    const subject = q.flashcard?.upload?.subject
    if (!subject) continue
    if (!bySubject.has(subject)) bySubject.set(subject, { correct: 0, total: 0 })
    const entry = bySubject.get(subject)
    entry.total += 1
    if (q.correct) entry.correct += 1
  }
  const result = new Map()
  for (const [subject, { correct, total }] of bySubject) {
    result.set(subject, total ? Math.round((correct / total) * 100) : null)
  }
  return result
}

/** Relative % change for "vs last week" deltas. null when there's no prior data to compare against. */
function pctChange(current, previous) {
  if (!previous) return current > 0 ? null : 0
  return Math.round(((current - previous) / previous) * 100)
}

function renderDelta(pct, compareLabel) {
  if (pct === null) return `<span class="stat-card__delta is-new">New this period</span>`
  const sign = pct >= 0 ? '▲' : '▼'
  const cls = pct >= 0 ? 'is-up' : 'is-down'
  return `<span class="stat-card__delta ${cls}">${sign} ${Math.abs(pct)}% vs ${compareLabel}</span>`
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

// --- Insights ("What [name] might need" — generated from real data) --------
const INSIGHT_ICONS = {
  practice: '📚',
  inactive: '📅',
  streak: '🔥',
  goal: '⏱️',
  steady: '🌱',
}

function buildInsights({ name, stats, streak, sessions, periodLabel, goalMinutes, periodDays }) {
  const insights = []

  const lowSubject = [...stats.subjectAccuracy.entries()].find(([, pct]) => pct != null && pct < 75)
  if (lowSubject) {
    insights.push({
      icon: INSIGHT_ICONS.practice,
      headline: `Needs more practice in ${lowSubject[0]}`,
      text: `Quiz accuracy in ${lowSubject[0]} is ${lowSubject[1]}% ${periodLabel} — a little extra review could help.`,
      priority: 1,
    })
  }

  const last = lastActive(sessions)
  const daysSince = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null
  if (daysSince != null && daysSince >= 2) {
    insights.push({
      icon: INSIGHT_ICONS.inactive,
      headline: `Hasn't studied in ${daysSince} days`,
      text: `A short, low-pressure session can help ${name} get back into the rhythm.`,
      priority: 2,
    })
  }

  if (streak >= 3) {
    insights.push({
      icon: INSIGHT_ICONS.streak,
      headline: `On a roll — ${streak} day streak!`,
      text: `${name} has studied ${streak} days in a row. Keep the momentum going.`,
      priority: 0,
    })
  }

  const avgDaily = periodDays ? stats.totalMinutes / periodDays : 0
  if (goalMinutes > 0 && avgDaily < goalMinutes * 0.9) {
    insights.push({
      icon: INSIGHT_ICONS.goal,
      headline: `Averaging ${Math.round(avgDaily)} min/day vs ${goalMinutes} min goal`,
      text: `A few more minutes a day would close the gap to ${name}'s daily goal.`,
      priority: 3,
    })
  }

  if (!insights.length) {
    insights.push({
      icon: INSIGHT_ICONS.steady,
      headline: 'Steady, consistent progress',
      text: `${name} is on track ${periodLabel} — keep up the routine.`,
      priority: 4,
    })
  }

  return insights.sort((a, b) => a.priority - b.priority).slice(0, 3)
}

function renderInsights(insights, name) {
  return `
    <div class="card insights-card">
      <h3 class="insights-card__title">What ${escapeHtml(name)} might need</h3>
      <div class="insight-list">
        ${insights.map((i) => `
          <div class="insight-card">
            <span class="insight-card__icon" aria-hidden="true">${i.icon}</span>
            <div>
              <p class="insight-card__headline">${escapeHtml(i.headline)}</p>
              <p class="insight-card__text">${escapeHtml(i.text)}</p>
            </div>
          </div>`).join('')}
      </div>
    </div>`
}

/** Fire-tier driven status line under the Focus streak stat. */
function streakStatus(streak) {
  if (streak <= 0) return 'Just getting started'
  if (streak <= 3) return 'Keep it up!'
  if (streak <= 6) return 'On track'
  return 'Great work!'
}

// --- Render -------------------------------------------------------------------
function render() {
  if (chartTooltip) chartTooltip.hidden = true // the chart markup is about to be torn down and rebuilt
  const { start, end } = periodBounds(period)
  const stats = computeStats(dataset, start, end)
  const { start: prevStart, end: prevEnd } = previousPeriodBounds(period, start)
  const prevStats = computeStats(dataset, prevStart, prevEnd)
  const streak = computeStreak(dataset.sessions)
  const last = lastActive(dataset.sessions)
  const periodLabel = period === 'week' ? 'this week' : 'this month'
  const compareLabel = period === 'week' ? 'last week' : 'last month'
  const periodDays = Math.round((end - start) / 86400000) + 1
  const goalMinutes = dataset.child.daily_goal_minutes ?? 30
  const name = dataset.child.name

  const rangeLabel = `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`

  const minutesDelta = renderDelta(pctChange(stats.totalMinutes, prevStats.totalMinutes), compareLabel)
  const accuracyDelta = stats.accuracy == null || prevStats.accuracy == null
    ? `<span class="stat-card__delta is-new">${prevStats.accuracy == null ? 'New this period' : '—'}</span>`
    : renderDelta(stats.accuracy - prevStats.accuracy, compareLabel)

  // Subject filter is scoped to whichever subjects appear in this period.
  if (!stats.subjects.some(([s]) => s === subjectFilter)) subjectFilter = 'all'
  const filterOptions = [`<option value="all">All subjects</option>`]
    .concat(stats.subjects.map(([s]) => `<option value="${escapeHtml(s)}"${s === subjectFilter ? ' selected' : ''}>${escapeHtml(s)}</option>`))
    .join('')

  const series = buildDailySeries(dataset.sessions, start, end, subjectFilter)
  const chartHtml = stats.subjects.length
    ? renderChart(series, period)
    : `<div class="chart-empty">No study sessions ${periodLabel} yet.</div>`

  const subjectRows = stats.subjects.length
    ? stats.subjects.map(([subject]) => {
        const mastery = stats.subjectAccuracy.get(subject)
        const pct = mastery ?? 0
        return `
          <div class="subject-row">
            <div class="subject-row__top"><span>${escapeHtml(subject)}</span><span>${mastery == null ? '—' : `${mastery}%`}</span></div>
            <div class="bar mastery-bar"><span style="width:${pct}%"></span></div>
          </div>`
      }).join('')
    : `<p class="muted">No subjects studied in this period yet.</p>`

  const insights = buildInsights({ name, stats, streak, sessions: dataset.sessions, periodLabel, goalMinutes, periodDays })

  contentEl.innerHTML = `
    <div class="analytics-week-head">
      <h2>${escapeHtml(name)}’s ${period === 'week' ? 'week' : 'month'}</h2>
      <span class="analytics-week-range">${rangeLabel}</span>
    </div>

    <div class="analytics-stats-row">
      <article class="card stat-card">
        <span class="stat-card__label">Study time</span>
        <span class="stat-card__value">${formatMinutes(stats.totalMinutes)}</span>
        ${minutesDelta}
      </article>
      <article class="card stat-card">
        <span class="stat-card__label">Quiz accuracy</span>
        <span class="stat-card__value">${stats.accuracy == null ? '—' : `${stats.accuracy}%`}</span>
        ${accuracyDelta}
      </article>
      <article class="card stat-card">
        <span class="stat-card__label">Focus streak</span>
        <span class="stat-card__value">${streak > 0 ? renderStreakBadge(streak) : `<span class="stat-card__value-plain">0 days</span>`}</span>
        <span class="stat-card__delta is-plain">${streakStatus(streak)}</span>
      </article>
    </div>

    <div class="analytics-bottom-row">
      <div class="card chart-card">
        <div class="chart-card__head">
          <h3>Daily study time</h3>
          <div class="chart-card__head-right">
            ${stats.subjects.length > 1 ? `<select class="subject-filter" id="subject-filter">${filterOptions}</select>` : ''}
            <span class="chart-card__axis-label">MINUTES</span>
          </div>
        </div>
        ${chartHtml}
      </div>

      <div class="card subjects-card">
        <div class="chart-card__head">
          <h3>Subject breakdown</h3>
          <span class="chart-card__axis-label">MASTERY</span>
        </div>
        <div class="subject-list">${subjectRows}</div>
      </div>
    </div>

    ${renderInsights(insights, name)}`

  $('#subject-filter')?.addEventListener('change', (e) => {
    subjectFilter = e.target.value
    render()
  })

  attachChartTooltip()
}

main()

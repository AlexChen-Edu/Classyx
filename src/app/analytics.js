// Per-child analytics: This Week / This Month stats computed client-side from
// one bulk fetch (study_sessions + quiz_results), so switching tabs is instant
// and never re-queries. Reached from the dashboard's "Analytics →" link as
// /app/analytics.html?child=CHILD_ID.
import { requireSession, signOut } from './auth.js'
import { getChildAnalytics } from './api.js'
import { $, escapeHtml, formatMinutes, formatDateTime } from './ui.js'

$('[data-signout]')?.addEventListener('click', signOut)

const nameEl = $('#child-name')
const gradeEl = $('#child-grade')
const contentEl = $('#analytics-content')
const tabs = document.querySelectorAll('[data-period]')

let dataset = null // { child, sessions, quizzes } — the full, unfiltered fetch
let period = 'week'

async function main() {
  const session = await requireSession()
  if (!session) return

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
function periodStart(p) {
  const now = new Date()
  if (p === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1)
  }
  // Monday 00:00 of the current week (matches the dashboard's "This week" math).
  const day = (now.getDay() + 6) % 7
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - day)
}

// --- Stats (pure functions over the already-fetched dataset) ----------------
function computeStats({ sessions, quizzes }, start) {
  const periodSessions = sessions.filter((s) => new Date(s.started_at) >= start)
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

  return { totalMinutes, activeDays, flashcardsReviewed, accuracy, subjects }
}

/** Current consecutive days studied, counting back from today. Not period-scoped — a streak is a global, ongoing thing. */
function computeStreak(sessions) {
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

/** Most recent session overall, not period-scoped — "last active" should be true regardless of which tab is open. */
function lastActive(sessions) {
  return sessions.length ? sessions[sessions.length - 1].started_at : null
}

// --- Render -------------------------------------------------------------------
function render() {
  const start = periodStart(period)
  const stats = computeStats(dataset, start)
  const streak = computeStreak(dataset.sessions)
  const last = lastActive(dataset.sessions)
  const maxSubjectMinutes = stats.subjects.length ? stats.subjects[0][1] : 0

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

  contentEl.innerHTML = `
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
}

main()

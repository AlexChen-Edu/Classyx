// Parent dashboard: per-child weekly study time, quiz accuracy, last studied.
import { requireSession, getFamily, signOut, setActiveChild } from './auth.js'
import { getDashboardData } from './api.js'
import { $, escapeHtml, relativeDay, initials, tintFor } from './ui.js'

const content = $('#content')
$('[data-signout]')?.addEventListener('click', signOut)

async function main() {
  const session = await requireSession()
  if (!session) return
  try {
    await getFamily() // bootstrap the family row on first login
    const children = await getDashboardData()
    render(children)
  } catch (err) {
    content.innerHTML = `<div class="banner banner--error">Couldn't load your dashboard: ${escapeHtml(err.message)}</div>`
  }
}

function render(children) {
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

  const cards = children.map((c) => {
    const tint = tintFor(c.name)
    const week = c.weekMinutes ? `${c.weekMinutes}m` : '0m'
    const acc = c.accuracy == null ? '—' : `${c.accuracy}%`
    return `
      <article class="card child-card">
        <div class="child-card__top">
          <span class="avatar" style="background:${tint}">${escapeHtml(initials(c.name))}</span>
          <div>
            <div class="child-card__name">${escapeHtml(c.name)}</div>
            <div class="child-card__grade">${c.grade ? 'Grade ' + escapeHtml(c.grade) : 'Learner'}</div>
          </div>
        </div>
        <div class="stat-mini-row">
          <div class="stat-mini"><div class="stat-mini__label">This week</div><div class="stat-mini__value">${week}</div></div>
          <div class="stat-mini"><div class="stat-mini__label">Quiz accuracy</div><div class="stat-mini__value">${acc}</div></div>
          <div class="stat-mini"><div class="stat-mini__label">Last studied</div><div class="stat-mini__value" style="font-size:.95rem">${escapeHtml(relativeDay(c.lastStudied))}</div></div>
        </div>
        <button class="btn btn-ghost btn-block" data-study="${c.id}">Start study session →</button>
      </article>`
  }).join('')

  content.innerHTML = `<div class="child-grid">${cards}</div>`

  content.querySelectorAll('[data-study]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const child = children.find((c) => c.id === btn.dataset.study)
      // Parent is authenticated and trusted here, so we skip the PIN gate.
      setActiveChild(child)
      location.href = '/app/study.html'
    })
  })
}

main()

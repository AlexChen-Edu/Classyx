// Study interface: sidebar layout with Home / Flashcards / Study Guides / Ask / Progress / Settings.
// All AI generation, ask-anything, and session logic is unchanged from the original.
import { supabase } from '../supabaseClient.js'
import { getActiveChild, getChildSession, setChildSession, getRememberedDevice, clearRememberedDevice, clearChildSession, clearActiveChild, markStudiedToday } from './auth.js'
import {
  uploadNote, generateContent, askQuestion, getFlashcards,
  startSession, touchSession,
  startPresence, pingPresence, endPresenceBeacon, getChildStreak,
  saveChildSession, saveChildSessionBeacon, getTodaySeconds,
} from './api.js'
import { $, $$, setStatus, loading, escapeHtml, computeStreak, renderStreakBadge, initials, tintFor, friendlyMessage } from './ui.js'

const MAX_BYTES = 10 * 1024 * 1024
const CHILD_URL = '/app/child.html'

let child = null
let viaParentSession = false

const els = {
  timer: $('#timer'),
  subject: $('#subject'),
  dropzone: $('#dropzone'),
  file: $('#file'),
  fileInfo: $('#file-info'),
  generate: $('#generate'),
  status: $('[data-status]'),
  uploadSection: $('#upload-section'),
  intentSection: $('#intent-section'),
  askSection: $('#ask-section'),
  askInputWrap: $('#ask-input-wrap'),
  askInput: $('#ask-input'),
  askBtn: $('#ask-btn'),
  askThread: $('#ask-thread'),
  askFollowupWrap: $('#ask-followup-wrap'),
  askFollowupInput: $('#ask-followup-input'),
  askFollowupBtn: $('#ask-followup-btn'),
  generating: $('#generating'),
  results: $('#results'),
  goalBarFill: $('#goal-bar-fill'),
  goalLabel: $('#goal-label'),
}

let chosenFile = null
let currentStudyMode = 'flashcards'
let currentUploadId = null

// Tracks which sub-mode was last successfully generated (for sidebar nav)
let activeResults = null
// Pre-selected intent coming from a home tool card ('flashcards' | 'summarize' | null)
let pendingIntent = null

const QUOTES = [
  'Discipline today, success tomorrow.',
  'Small steps every day lead to big results.',
  'Every expert was once a beginner.',
  'The secret of getting ahead is getting started.',
  'Hard work beats talent when talent doesn\'t work hard.',
]

/**
 * The active child can come from either trust path:
 *  - a parent's authenticated session + a profile picked on child.html, or
 *  - an account-less child session (redeem_child_code) stored for this tab.
 * If neither is present, fall back to the remembered device in localStorage.
 */
async function resolveActiveChild() {
  if (supabase) {
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      const picked = getActiveChild()
      if (picked) {
        viaParentSession = true
        return { ...picked, daily_goal_minutes: picked.daily_goal_minutes ?? 30 }
      }
    }
  }
  const childSession = getChildSession()
  if (childSession) {
    return {
      id: childSession.child_id, name: childSession.child_name, family_id: childSession.family_id,
      daily_goal_minutes: childSession.daily_goal_minutes ?? 30,
    }
  }
  const remembered = getRememberedDevice()
  if (remembered) {
    setChildSession({
      child_id: remembered.child_id, child_name: remembered.child_name, family_id: remembered.family_id,
      daily_goal_minutes: remembered.daily_goal_minutes,
    })
    return {
      id: remembered.child_id, name: remembered.child_name, family_id: remembered.family_id,
      daily_goal_minutes: remembered.daily_goal_minutes ?? 30,
    }
  }
  return null
}

async function main() {
  child = await resolveActiveChild()
  if (!child) {
    location.replace(CHILD_URL)
    return
  }
  renderSidebarChild(child)
  renderHomeGreeting(child)
  renderHomeQuote()
  loadRecentActivity()
  wireNav()
  wireToolCards()
  wireBackButtons()
  wireUpload()
  wireIntent()
  wireAskSection()
  wireForgetDevice()
  wireEndSession()
  startTimer()
  renderStreak()
  showMascot("Let's go! 📚")
}

// ============================ Sidebar child footer ===========================
function renderSidebarChild(child) {
  const container = $('#sidebar-child')
  if (!container) return
  const color = tintFor(child.name)
  container.innerHTML = `
    <div class="study-sidebar__child-avatar" style="background:${escapeHtml(color)}">${escapeHtml(initials(child.name))}</div>
    <span class="study-sidebar__child-name">${escapeHtml(child.name)}</span>`
  const nameEl = $('#settings-child-name')
  if (nameEl) nameEl.textContent = child.name
}

// ============================ Navigation ====================================
function showView(viewName) {
  $$('.study-view').forEach((v) => v.classList.add('hidden'))
  $(`#view-${viewName}`)?.classList.remove('hidden')
}

function setActiveNavItem(navName) {
  $$('[data-nav]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.nav === navName)
  })
}

function navigateTo(navName) {
  switch (navName) {
    case 'home':
      showView('home')
      setActiveNavItem('home')
      break

    case 'flashcards':
      showView('upload')
      setActiveNavItem('flashcards')
      if (activeResults === 'flashcards') {
        showResults('flashcards')
      } else {
        pendingIntent = 'flashcards'
        updateUploadContext('flashcards')
        show('upload')
      }
      break

    case 'study-guides':
      showView('upload')
      setActiveNavItem('study-guides')
      if (activeResults === 'summarize') {
        showResults('summarize')
      } else {
        pendingIntent = 'summarize'
        updateUploadContext('study-guides')
        show('upload')
      }
      break

    case 'ask':
      showView('ask')
      setActiveNavItem('ask')
      break

    case 'progress':
      if (child?.id) location.href = `/app/analytics.html?child=${child.id}`
      break

    case 'settings':
      showView('settings')
      setActiveNavItem('settings')
      break
  }
}

function wireNav() {
  $$('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.nav))
  })
  // Mobile hamburger: toggle sidebar overlay (future enhancement)
  $('#sidebar-toggle')?.addEventListener('click', () => {
    const sidebar = $('#study-sidebar')
    if (!sidebar) return
    const open = sidebar.classList.toggle('is-open')
    $('#sidebar-toggle')?.setAttribute('aria-expanded', String(open))
  })
}

// ============================ Home view =====================================
function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function renderHomeGreeting(child) {
  const el = $('#home-greeting')
  if (el) el.textContent = `${getGreeting()}, ${child.name} 👋`
}

function renderHomeQuote() {
  const el = $('#home-quote')
  if (el) el.textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)]
}

function timeAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

async function loadRecentActivity() {
  const container = $('#home-recent')
  if (!container || !supabase) return
  try {
    const { data, error } = await supabase
      .from('study_sessions')
      .select('started_at, subject')
      .eq('child_id', child.id)
      .order('started_at', { ascending: false })
      .limit(3)
    if (error) throw error
    if (!data?.length) {
      container.innerHTML = '<p class="muted" style="text-align:center;padding:22px 0">No sessions yet — start studying to see your history!</p>'
      return
    }
    container.innerHTML = data.map((session) => {
      const subj = session.subject || 'General'
      const color = tintFor(subj)
      return `
        <div class="recent-row">
          <div class="recent-row__icon" style="background:${escapeHtml(color)}22">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${escapeHtml(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
          </div>
          <div class="recent-row__info">
            <div class="recent-row__title">${escapeHtml(subj)}</div>
            <div class="recent-row__type">Study session</div>
          </div>
          <div class="recent-row__time">${escapeHtml(timeAgo(session.started_at))}</div>
        </div>`
    }).join('')
  } catch {
    container.innerHTML = '<p class="muted" style="text-align:center;padding:22px 0">Could not load recent activity.</p>'
  }
}

// ============================ Tool cards ====================================
function wireToolCards() {
  $$('[data-tool]').forEach((card) => {
    card.addEventListener('click', () => {
      const tool = card.dataset.tool
      if (tool === 'ask') {
        navigateTo('ask')
      } else {
        navigateTo(tool) // 'flashcards' or 'study-guides'
      }
    })
  })
}

function wireBackButtons() {
  $('#back-to-home-upload')?.addEventListener('click', () => navigateTo('home'))
  $('#back-to-home-ask')?.addEventListener('click', () => navigateTo('home'))
}

// Update upload section title/button to reflect pre-selected intent
function updateUploadContext(context) {
  const titleEl = $('#upload-view-title')
  const subEl = $('#upload-view-sub')
  if (context === 'flashcards') {
    if (titleEl) titleEl.textContent = 'Generate Flashcards'
    if (subEl) subEl.textContent = "Upload your notes and we'll make flashcards."
    els.generate.textContent = 'Make me flashcards →'
  } else if (context === 'study-guides') {
    if (titleEl) titleEl.textContent = 'Generate Study Guide'
    if (subEl) subEl.textContent = "Upload your notes and we'll summarize them."
    els.generate.textContent = 'Generate study guide →'
  } else {
    if (titleEl) titleEl.textContent = 'Upload your notes'
    if (subEl) subEl.textContent = "Snap a photo or drop a PDF — we'll help you study."
    els.generate.textContent = 'Choose how to study →'
  }
  // Re-disable generate if no file chosen yet
  if (!chosenFile) els.generate.disabled = true
}

// ============================ Mascot (Tamagotchi effect) ====================
let mascotTimer = null
let mascotHitTenMin = false

function showMascot(text, ms = 4000) {
  const bubble = $('#mascot-bubble')
  if (!bubble) return
  clearTimeout(mascotTimer)
  bubble.textContent = text
  bubble.hidden = false
  requestAnimationFrame(() => bubble.classList.add('is-visible'))
  mascotTimer = setTimeout(() => {
    bubble.classList.remove('is-visible')
    setTimeout(() => { bubble.hidden = true }, 250)
  }, ms)
}

/**
 * Account-less children have no RLS access to study_sessions (anon has no
 * policy on that table at all — only the parent-authenticated path does),
 * so this throws for them; treated the same as "no streak yet" (0 days =
 * nothing shown), which is the correct UI anyway.
 */
let currentStreak = 0
async function renderStreak() {
  const slot = $('#topbar-streak')
  if (!slot) return
  try {
    const sessions = await getChildStreak(child.id)
    currentStreak = computeStreak(sessions)
    slot.innerHTML = renderStreakBadge(currentStreak)
  } catch {
    slot.innerHTML = ''
  }
}

function wireForgetDevice() {
  $('#forget-device')?.addEventListener('click', () => {
    if (!confirm("Are you sure? You'll need to enter your code again next time.")) return
    clearRememberedDevice()
    location.href = CHILD_URL
  })
}

function wireEndSession() {
  $('#end-session')?.addEventListener('click', async () => {
    const btn = $('#end-session')
    const restore = loading(btn, 'Saving…')
    try {
      if (viaParentSession) {
        if (sessionRow) await touchSession({ sessionId: sessionRow.id, startedAtMs, pausedMs: totalPausedMs })
      } else {
        await saveAnonSessionAwaited()
      }
    } catch { /* best effort */ }
    endPresence()
    markStudiedToday(child.id)
    restore()
    showCelebration()
  })
}

// ============================ Session celebration (Optimism & Identity) ====
const IDENTITY_LINES = [
  "That's what serious students do.",
  'Another day, another step ahead.',
  'You showed up today. That matters.',
  "Future you is already proud of this.",
  'Small sessions like this add up fast.',
]

function showCelebration() {
  const overlay = $('#session-celebration')
  if (!overlay) { location.href = CHILD_URL; return }

  $('#celebration-avatar').textContent = initials(child.name)
  $('#celebration-avatar').style.background = tintFor(child.name)
  $('#celebration-name').textContent = `Nice work, ${child.name}!`
  $('#celebration-streak').textContent = currentStreak > 0
    ? `🔥 ${currentStreak}-day streak`
    : 'First session logged — keep it going.'
  $('#celebration-line').textContent = IDENTITY_LINES[Math.floor(Math.random() * IDENTITY_LINES.length)]

  overlay.hidden = false

  const finish = () => {
    clearTimeout(timer)
    overlay.removeEventListener('click', finish)
    location.href = CHILD_URL
  }
  const timer = setTimeout(finish, 3000)
  overlay.addEventListener('click', finish)
}

// ============================ Timer / session ==============================
let sessionRow = null
let startedAtMs = Date.now()
let seconds = 0
let priorTodaySeconds = 0
let tickInterval = null
let saveInterval = null
let pingInterval = null
let presenceEnded = false
let totalPausedMs = 0
let pausedAtMs = null
let anonSessionSaved = false

function updateDisplay() {
  els.timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  updateGoalBar()
}

let goalReached = false
function updateGoalBar() {
  if (!els.goalBarFill) return
  const goalSeconds = (child?.daily_goal_minutes || 30) * 60
  const pct = Math.min(100, Math.round(((seconds + priorTodaySeconds) / goalSeconds) * 100))
  els.goalBarFill.style.width = `${pct}%`
  if (pct >= 100) {
    if (!goalReached) {
      goalReached = true
      els.goalBarFill.classList.add('is-complete')
      els.goalLabel?.classList.add('is-complete')
      showMascot('Goal crushed. 🔥')
    }
    if (els.goalLabel) els.goalLabel.textContent = '🎉 Daily goal reached!'
  } else {
    if (els.goalLabel) els.goalLabel.textContent = `${pct}% of today's goal`
  }
}

function startTick() {
  if (tickInterval) return
  tickInterval = setInterval(() => {
    seconds++
    updateDisplay()
    if (!mascotHitTenMin && seconds >= 600) {
      mascotHitTenMin = true
      showMascot("You're on a roll.")
    }
  }, 1000)
}

function stopTick() {
  clearInterval(tickInterval)
  tickInterval = null
}

async function startTimer() {
  startedAtMs = Date.now()
  seconds = 0
  priorTodaySeconds = 0
  totalPausedMs = 0

  // Seed the XP bar from today's already-completed study time (parent-session path only;
  // account-less children have no RLS access to study_sessions so we leave priorTodaySeconds=0).
  if (viaParentSession) {
    try { priorTodaySeconds = await getTodaySeconds(child.id) } catch { /* best effort */ }
  }

  updateDisplay()
  startTick()
  if (viaParentSession) {
    try {
      sessionRow = await startSession({ childId: child.id, subject: els.subject.value || null })
    } catch { /* timer still shows; we just won't persist if this failed */ }
    saveInterval = setInterval(saveSession, 60000)
    window.addEventListener('pagehide', saveSession)
  } else {
    window.addEventListener('pagehide', saveAnonSessionBeacon)
    window.addEventListener('beforeunload', saveAnonSessionBeacon)
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)

  try {
    const presence = await startPresence(child.id)
    if (presence?.childMissing) {
      stopTick()
      clearInterval(saveInterval)
      clearRememberedDevice()
      clearChildSession()
      clearActiveChild()
      location.replace(CHILD_URL)
      return
    }
  } catch { /* best effort */ }
  startPresencePing()
  window.addEventListener('pagehide', endPresence)
  window.addEventListener('beforeunload', endPresence)
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopTick()
    pausedAtMs = Date.now()
  } else {
    if (pausedAtMs) totalPausedMs += Date.now() - pausedAtMs
    pausedAtMs = null
    startTick()
    showMascot('Welcome back — let\'s finish strong.')
  }
}

function startPresencePing() {
  pingInterval = setInterval(() => pingPresence(child.id, totalPausedMs).catch(() => {}), 5000)
}

function saveSession() {
  if (sessionRow) touchSession({ sessionId: sessionRow.id, startedAtMs, pausedMs: totalPausedMs })
}

function elapsedMinutes() {
  return Math.max(1, Math.round((Date.now() - startedAtMs - totalPausedMs) / 60000))
}

function elapsedSeconds() {
  return Math.max(0, Math.round((Date.now() - startedAtMs - totalPausedMs) / 1000))
}

function saveAnonSessionBeacon() {
  if (anonSessionSaved || viaParentSession) return
  anonSessionSaved = true
  saveChildSessionBeacon({
    childId: child.id,
    subject: els.subject.value || null,
    durationMinutes: elapsedMinutes(),
    durationSeconds: elapsedSeconds(),
  })
}

async function saveAnonSessionAwaited() {
  if (anonSessionSaved || viaParentSession) return
  anonSessionSaved = true
  await saveChildSession({
    childId: child.id,
    subject: els.subject.value || null,
    durationMinutes: elapsedMinutes(),
    durationSeconds: elapsedSeconds(),
  })
}

function endPresence() {
  if (presenceEnded || !child) return
  presenceEnded = true
  stopTick()
  clearInterval(pingInterval)
  clearInterval(saveInterval)
  endPresenceBeacon(child.id)
}

// ============================ Upload + generate ============================
function wireUpload() {
  els.dropzone.addEventListener('click', () => els.file.click())
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click() }
  })
  els.file.addEventListener('change', () => setFile(els.file.files[0]))

  ;['dragenter', 'dragover'].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => { e.preventDefault(); els.dropzone.classList.add('is-drag') }))
  ;['dragleave', 'drop'].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => { e.preventDefault(); els.dropzone.classList.remove('is-drag') }))
  els.dropzone.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]))

  els.generate.addEventListener('click', () => {
    if (pendingIntent) {
      generate(pendingIntent)
    } else {
      show('intent')
    }
  })
}

function wireIntent() {
  $$('[data-intent]').forEach((card) => {
    card.addEventListener('click', () => generate(card.dataset.intent))
  })
  $('#back-to-upload')?.addEventListener('click', () => show('upload'))
}

function setFile(file) {
  if (!file) return
  const ok = file.type.startsWith('image/') || file.type === 'application/pdf'
  if (!ok) return setStatus(els.status, 'Please choose an image or PDF.', 'error')
  if (file.size > MAX_BYTES) return setStatus(els.status, 'That file is over 10 MB. Try a smaller one.', 'error')
  chosenFile = file
  setStatus(els.status, '')
  els.fileInfo.innerHTML = `<span class="file-pill">📄 ${escapeHtml(file.name)}</span>`
  els.generate.disabled = false
}

async function generate(mode) {
  if (!chosenFile) return
  currentStudyMode = mode
  const subject = els.subject.value || 'General'

  const titles = {
    flashcards: 'Building your study pack…',
    solve: 'Analyzing your problem…',
    summarize: 'Summarizing your notes…',
  }
  const notes = {
    flashcards: 'Reading your notes and writing flashcards. This takes 5–15 seconds.',
    solve: 'Thinking through the Socratic guidance. This takes 5–10 seconds.',
    summarize: 'Pulling out the key points. This takes 5–10 seconds.',
  }
  $('#generating-title').textContent = titles[mode] || 'Working on it…'
  $('#generating-note').textContent = notes[mode] || 'This takes 5–15 seconds.'

  show('generating')
  try {
    const upload = await uploadNote({ child, file: chosenFile, subject, viaParentSession })
    currentUploadId = upload.id
    const result = await generateContent({ uploadId: upload.id, childId: child.id, subject, viaParentSession, mode })

    if (mode === 'flashcards') {
      const cards = await getFlashcards(upload.id, viaParentSession)
      if (!cards.length) throw new Error('No flashcards were generated. Try a clearer photo.')
      loadDeck(cards)
      activeResults = 'flashcards'
      showResults('flashcards')
    } else if (mode === 'solve') {
      renderSolveResult(result.result)
      activeResults = 'solve'
      showResults('solve')
      showMascot("Think it through — you've got this.")
    } else if (mode === 'summarize') {
      renderSummarizeResult(result.result)
      activeResults = 'summarize'
      showResults('summarize')
    }
  } catch (err) {
    show('upload')
    if (err.notConfigured) {
      setStatus(els.status, '', '')
      banner(`<div class="banner banner--info">${escapeHtml(err.message)}</div>`)
    } else if (err.creditsExhausted) {
      setStatus(els.status, "You've used all your study credits for this month. Let your parent know to check the plan.", 'error')
    } else {
      setStatus(els.status, friendlyMessage(err, 'Generation failed. Please try again.'), 'error')
    }
  }
}

function banner(html) {
  const existing = $('#gen-banner')
  if (existing) existing.remove()
  const div = document.createElement('div')
  div.id = 'gen-banner'
  div.innerHTML = html
  els.uploadSection.prepend(div)
}

/** Show one of the upload sub-views; any other string hides them all. */
function show(view) {
  els.uploadSection.classList.toggle('hidden', view !== 'upload')
  els.intentSection.classList.toggle('hidden', view !== 'intent')
  els.generating.classList.toggle('hidden', view !== 'generating')
  els.results.classList.toggle('hidden', view !== 'results')
}

function showResults(mode) {
  $('#results-flashcards').classList.toggle('hidden', mode !== 'flashcards')
  $('#results-solve').classList.toggle('hidden', mode !== 'solve')
  $('#results-summarize').classList.toggle('hidden', mode !== 'summarize')
  show('results')
}

function resetToUpload() {
  chosenFile = null
  els.file.value = ''
  els.fileInfo.innerHTML = ''
  pendingIntent = null
  updateUploadContext(null)
  show('upload')
}

$('#new-upload')?.addEventListener('click', resetToUpload)
$('#new-upload-solve')?.addEventListener('click', resetToUpload)
$('#new-upload-summarize')?.addEventListener('click', resetToUpload)

// ============================ Markdown renderer ============================
function renderMd(text) {
  if (!text) return ''
  const latexBlocks = []
  const MARK = ''
  const safe = text.replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, (m) => {
    latexBlocks.push(escapeHtml(m))
    return `${MARK}${latexBlocks.length - 1}${MARK}`
  })
  let out = escapeHtml(safe)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  out = out
    .split('\n\n')
    .map((p) => `<p class="ask-answer__para">${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
  if (latexBlocks.length) {
    out = out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i) => latexBlocks[+i])
  }
  return out
}

// ============================ Result renderers =============================
function renderSolveResult(result) {
  const el = $('#solve-content')
  if (!result) { el.innerHTML = '<p class="muted">No guidance was generated.</p>'; return }
  el.innerHTML = `
    <h3 style="margin-top:0">The Concept</h3>
    <p class="guide__summary">${escapeHtml(result.concept || '')}</p>
    <h3>A Hint</h3>
    <p class="guide__summary">${escapeHtml(result.hint || '')}</p>
    <h3>Think About This</h3>
    <p class="guide__summary" style="font-style:italic;color:var(--brand-ink)">${escapeHtml(result.guiding_question || '')}</p>
    <div style="margin-top:20px">
      <button class="btn btn-ghost btn-sm" id="show-first-step-btn" type="button">Show first step</button>
      <div id="first-step-content" class="hidden" style="margin-top:12px">
        <h3>First Step</h3>
        <p class="guide__summary">${escapeHtml(result.first_step || '')}</p>
      </div>
    </div>
    <div style="text-align:center;margin-top:28px">
      <button class="btn btn-ghost" id="reveal-answer-btn" type="button">Reveal full answer</button>
    </div>
    <div id="solve-reveal-content"></div>`

  $('#show-first-step-btn')?.addEventListener('click', () => {
    const content = $('#first-step-content')
    const btn = $('#show-first-step-btn')
    if (content.classList.contains('hidden')) {
      content.classList.remove('hidden')
      btn.textContent = 'Hide first step'
    } else {
      content.classList.add('hidden')
      btn.textContent = 'Show first step'
    }
  })

  $('#reveal-answer-btn')?.addEventListener('click', revealFullAnswer)
}

async function revealFullAnswer() {
  const btn = $('#reveal-answer-btn')
  const container = $('#solve-reveal-content')
  if (!btn || !container || !currentUploadId) return
  const restore = loading(btn, 'Loading solution…')
  try {
    const data = await generateContent({
      uploadId: currentUploadId,
      childId: child.id,
      subject: els.subject.value || 'General',
      viaParentSession,
      mode: 'solve_reveal',
    })
    btn.style.display = 'none'
    const steps = (data.result?.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    container.innerHTML = `
      <hr style="margin:20px 0;opacity:0.2">
      <h3>Full Solution</h3>
      <p class="guide__summary">${escapeHtml(data.result?.solution || '')}</p>
      ${steps ? `<ol style="padding-left:1.4em">${steps}</ol>` : ''}`
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger);margin-top:12px">${escapeHtml(friendlyMessage(err, 'Could not load solution. Please try again.'))}</p>`
    restore()
  }
}

function renderSummarizeResult(result) {
  const el = $('#summarize-content')
  if (!result) { el.innerHTML = '<p class="muted">No summary was generated.</p>'; return }
  const keyPoints = (result.key_points || []).map((p) => `<li>${escapeHtml(p)}</li>`).join('')
  el.innerHTML = `
    <h3 style="margin-top:0">Summary</h3>
    <p class="guide__summary">${escapeHtml(result.summary || '')}</p>
    ${keyPoints ? `<h3>Key Points</h3><ul>${keyPoints}</ul>` : ''}`
}

function renderAskResult(result, container, onChipClick) {
  const followUps = (result.follow_up_questions || [])
    .map((q) => `<button class="followup-chip" type="button">${escapeHtml(q)}</button>`)
    .join('')
  const followUpsHtml = followUps
    ? `<div style="margin-top:16px"><p class="ask-explore-label">Dig deeper</p><div class="followup-chips">${followUps}</div></div>`
    : ''

  let html
  if (result.response_type === 'simple') {
    html = `
      <div class="ask-simple">
        <p class="ask-headline">${renderMd(result.headline || '')}</p>
        <div class="ask-answer">${renderMd(result.answer || '')}</div>
        ${followUpsHtml}
      </div>`
  } else {
    const keyPoints = (result.key_points || []).map((p) => `<li class="ask-kp">${renderMd(p)}</li>`).join('')
    html = `
      <div class="ask-detailed guide">
        ${result.headline ? `<h3 class="ask-detailed__title">${escapeHtml(result.headline)}</h3>` : ''}
        <div class="ask-answer">${renderMd(result.answer || '')}</div>
        ${keyPoints ? `<h3>Key points</h3><ul class="ask-kp-list">${keyPoints}</ul>` : ''}
        ${followUpsHtml}
      </div>`
  }

  container.innerHTML = html
  if (typeof MathJax !== 'undefined') {
    ;(MathJax.startup?.promise ?? Promise.resolve())
      .then(() => MathJax.typesetPromise([container]))
      .catch(console.error)
  }
  container.querySelectorAll('.followup-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (onChipClick) {
        onChipClick(chip.textContent)
      } else {
        els.askFollowupInput.value = chip.textContent
        els.askFollowupBtn.disabled = false
        els.askFollowupInput.focus()
      }
    })
  })
}

// ============================ Ask anything — conversation thread ===========
let conversationHistory = []

function summariseForHistory(result) {
  const parts = []
  if (result.headline) parts.push(result.headline.replace(/\*\*/g, ''))
  if (result.answer) parts.push(result.answer.replace(/\*\*/g, ''))
  if (result.key_points?.length) parts.push(result.key_points.join('. '))
  return parts.join('\n\n')
}

function fillFollowup(text) {
  els.askFollowupInput.value = text
  els.askFollowupBtn.disabled = false
  sendFollowup()
}

function appendExchange(question, result) {
  const exchange = document.createElement('div')
  exchange.className = 'ask-exchange'

  const userBubble = document.createElement('div')
  userBubble.className = 'ask-user-bubble'
  userBubble.textContent = question

  const aiResponse = document.createElement('div')
  aiResponse.className = 'ask-ai-response'

  exchange.appendChild(userBubble)
  exchange.appendChild(aiResponse)
  els.askThread.appendChild(exchange)

  renderAskResult(result, aiResponse, fillFollowup)

  requestAnimationFrame(() =>
    exchange.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  )
}

function showThread(question, result) {
  conversationHistory = []
  els.askInputWrap.classList.add('hidden')
  els.askThread.innerHTML = ''
  els.askThread.classList.remove('hidden')
  els.askFollowupWrap.classList.remove('hidden')
  appendExchange(question, result)
}

function wireAskSection() {
  els.askInput.addEventListener('input', () => {
    els.askBtn.disabled = !els.askInput.value.trim()
  })
  els.askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !els.askBtn.disabled) ask()
  })
  els.askBtn.addEventListener('click', ask)

  els.askFollowupInput.addEventListener('input', () => {
    els.askFollowupBtn.disabled = !els.askFollowupInput.value.trim()
  })
  els.askFollowupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !els.askFollowupBtn.disabled) sendFollowup()
  })
  els.askFollowupBtn.addEventListener('click', sendFollowup)
}

async function ask() {
  const question = els.askInput.value.trim()
  if (!question) return

  const statusEl = $('[data-ask-status]')
  setStatus(statusEl, '', '')
  els.askBtn.disabled = true
  els.askBtn.textContent = 'Asking…'

  try {
    const data = await askQuestion({ childId: child.id, question, viaParentSession })
    showThread(question, data.result)
    conversationHistory.push({ role: 'user', content: question })
    conversationHistory.push({ role: 'assistant', content: summariseForHistory(data.result) })
    showMascot('Great question!')
  } catch (err) {
    handleAskError(err, statusEl)
  } finally {
    els.askBtn.disabled = false
    els.askBtn.textContent = 'Ask'
  }
}

async function sendFollowup() {
  const question = els.askFollowupInput.value.trim()
  if (!question) return

  const statusEl = $('[data-ask-status]')
  setStatus(statusEl, '', '')
  els.askFollowupInput.value = ''
  els.askFollowupBtn.disabled = true
  els.askFollowupInput.disabled = true

  els.askThread.querySelectorAll('.followup-chips').forEach((el) => {
    el.parentElement?.remove()
  })

  const exchange = document.createElement('div')
  exchange.className = 'ask-exchange'
  const userBubble = document.createElement('div')
  userBubble.className = 'ask-user-bubble'
  userBubble.textContent = question
  const aiResponse = document.createElement('div')
  aiResponse.className = 'ask-ai-response ask-ai-response--loading'
  aiResponse.innerHTML = '<span class="spinner"></span>'
  exchange.appendChild(userBubble)
  exchange.appendChild(aiResponse)
  els.askThread.appendChild(exchange)
  requestAnimationFrame(() =>
    exchange.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  )

  try {
    const data = await askQuestion({
      childId: child.id,
      question,
      viaParentSession,
      context: conversationHistory,
    })
    aiResponse.className = 'ask-ai-response'
    aiResponse.innerHTML = ''
    renderAskResult(data.result, aiResponse, fillFollowup)
    conversationHistory.push({ role: 'user', content: question })
    conversationHistory.push({ role: 'assistant', content: summariseForHistory(data.result) })
    showMascot('Keep the questions coming!')
    requestAnimationFrame(() =>
      exchange.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    )
  } catch (err) {
    aiResponse.className = 'ask-ai-response'
    aiResponse.innerHTML = ''
    handleAskError(err, statusEl)
  } finally {
    els.askFollowupBtn.disabled = !els.askFollowupInput.value.trim()
    els.askFollowupInput.disabled = false
    els.askFollowupInput.focus()
  }
}

function handleAskError(err, statusEl) {
  if (err.creditsExhausted) {
    setStatus(statusEl, "You've used all your study credits for this month. Let your parent know to check the plan.", 'error')
  } else if (err.notConfigured) {
    setStatus(statusEl, err.message, 'error')
  } else {
    setStatus(statusEl, friendlyMessage(err, 'Could not get an answer. Please try again.'), 'error')
  }
}

// ============================ Flashcard deck ==============================
let deck = []
let deckIndex = 0
const flashcard = $('#flashcard')

function loadDeck(cards) {
  deck = cards
  deckIndex = 0
  renderCard()
}

function renderCard() {
  const card = deck[deckIndex]
  if (!card) return
  flashcard.classList.remove('is-flipped')
  $('#card-q').textContent = card.question
  $('#card-a').textContent = card.answer
  $('#deck-count').textContent = `${deckIndex + 1} / ${deck.length}`
}

flashcard.addEventListener('click', () => flashcard.classList.toggle('is-flipped'))
flashcard.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flashcard.classList.toggle('is-flipped') }
})
$('#prev').addEventListener('click', () => { deckIndex = (deckIndex - 1 + deck.length) % deck.length; renderCard() })
$('#next').addEventListener('click', () => { deckIndex = (deckIndex + 1) % deck.length; renderCard() })


main()

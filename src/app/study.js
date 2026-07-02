// Study interface: upload -> intent selection -> AI generate -> results,
// plus an "Ask anything" tab for text questions without a file upload.
import { supabase } from '../supabaseClient.js'
import { getActiveChild, getChildSession, setChildSession, getRememberedDevice, clearRememberedDevice, clearChildSession, clearActiveChild, markStudiedToday } from './auth.js'
import {
  uploadNote, generateContent, askQuestion, getFlashcards, getStudyGuide,
  recordQuizResult, startSession, touchSession,
  startPresence, pingPresence, endPresenceBeacon, getChildStreak,
  saveChildSession, saveChildSessionBeacon,
} from './api.js'
import { $, $$, setStatus, loading, escapeHtml, computeStreak, renderStreakBadge, initials, tintFor, friendlyMessage } from './ui.js'

const MAX_BYTES = 10 * 1024 * 1024
const CHILD_URL = '/app/child.html'

let child = null
/** True only for a parent's authenticated session + a profile picked on child.html. */
let viaParentSession = false

const els = {
  childName: $('#child-name'),
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

/**
 * The active child can come from either trust path:
 *  - a parent's authenticated session + a profile picked on child.html, or
 *  - an account-less child session (redeem_child_code) stored for this tab.
 * If neither is present, fall back to the remembered device in localStorage
 * — this is the case of a closed-and-reopened tab, where sessionStorage was
 * wiped but the "remember this device" profile survived.
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
  els.childName.textContent = child.name
  startTimer()
  wireUpload()
  wireIntent()
  wireModeTab()
  wireAskSection()
  wireTabs()
  wireForgetDevice()
  wireEndSession()
  renderStreak()
  showMascot("Let's go! 📚")
}

// ============================ Mascot (Tamagotchi effect) ===================
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
  const slot = $('#streak-slot')
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

/** XP-bar-style fill: seconds studied / daily goal (in seconds), capped at 100%. */
let goalReached = false
function updateGoalBar() {
  if (!els.goalBarFill) return
  const goalSeconds = (child?.daily_goal_minutes || 30) * 60
  const pct = Math.min(100, Math.round((seconds / goalSeconds) * 100))
  els.goalBarFill.style.width = `${pct}%`
  if (pct >= 100) {
    if (!goalReached) {
      goalReached = true
      els.goalBarFill.classList.add('is-complete')
      els.goalLabel.classList.add('is-complete')
      showMascot('Goal crushed. 🔥')
    }
    els.goalLabel.textContent = '🎉 Daily goal reached!'
  } else {
    els.goalLabel.textContent = `${pct}% of today's goal`
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
  totalPausedMs = 0
  updateDisplay()
  startTick()
  if (viaParentSession) {
    try {
      sessionRow = await startSession({ childId: child.id, subject: els.subject.value || null })
    } catch { /* timer still shows; we just won't persist if this failed */ }
    // Auto-save every 60s so progress survives an abrupt close. Safe to call
    // repeatedly since it's an UPDATE on the same row, unlike the anon path's
    // one-shot RPC below.
    saveInterval = setInterval(saveSession, 60000)
    window.addEventListener('pagehide', saveSession)
  } else {
    // Account-less child: no row to update, so there's nothing to autosave —
    // just a single save at the true end of the session (pagehide/
    // beforeunload here, or the "End session" button). Registered before
    // endPresence's own pagehide/beforeunload listeners below so the save
    // request is issued first, while its required active_sessions row still
    // exists (see the save_child_session migration).
    window.addEventListener('pagehide', saveAnonSessionBeacon)
    window.addEventListener('beforeunload', saveAnonSessionBeacon)
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)

  // Live presence for the parent dashboard's "Active now" indicator.
  try {
    const presence = await startPresence(child.id)
    if (presence?.childMissing) {
      // This profile was deleted (most likely from a stale "remembered
      // device" pointing at a child the parent has since removed) — bail
      // out before wiring up more intervals/listeners for a session that
      // can never be saved.
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
  // pagehide fires both on real tab close and on normal in-app navigation
  // (e.g. clicking "Switch"), so this also ends presence on the latter.
  window.addEventListener('pagehide', endPresence)
  window.addEventListener('beforeunload', endPresence)
}

/** Tab hidden: stop ticking seconds so the display freezes; tab visible: resume from where it left off. */
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

/** Separate from the display timer — just keeps active_sessions fresh for the parent dashboard. */
function startPresencePing() {
  pingInterval = setInterval(() => pingPresence(child.id, totalPausedMs).catch(() => {}), 5000)
}

function saveSession() {
  if (sessionRow) touchSession({ sessionId: sessionRow.id, startedAtMs, pausedMs: totalPausedMs })
}

/**
 * Same calc touchSession uses internally, exposed here so the anon path can
 * pass it explicitly. Floors at 1 (not 0): a session under 30 seconds would
 * otherwise round down to 0 minutes and effectively vanish from the
 * dashboard/streak — any session that actually started counts for at least
 * one minute.
 */
function elapsedMinutes() {
  return Math.max(1, Math.round((Date.now() - startedAtMs - totalPausedMs) / 60000))
}

/** Exact elapsed seconds, unrounded/unfloored — for the dashboard's daily-goal ring. */
function elapsedSeconds() {
  return Math.max(0, Math.round((Date.now() - startedAtMs - totalPausedMs) / 1000))
}

/** Fire-and-forget; for pagehide/beforeunload, where an awaited call can't be trusted to finish. */
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

/** Awaited variant for the "End session" button, where we can show a loading state and wait. */
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

/**
 * Fires on "End session" and on tab close (pagehide/beforeunload) — i.e.
 * whenever the session is actually over. Stops every interval, including
 * the display poll, so the timer freezes at whatever it last showed instead
 * of continuing to tick (or jump) after the session has ended.
 */
function endPresence() {
  if (presenceEnded || !child) return
  presenceEnded = true
  stopTick()
  clearInterval(pingInterval)
  clearInterval(saveInterval)
  endPresenceBeacon(child.id)
}

// ============================ Mode tabs (Upload / Ask) =====================
function wireModeTab() {
  $$('#mode-tab-bar [data-mode]').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('#mode-tab-bar [data-mode]').forEach((t) =>
        t.setAttribute('aria-selected', String(t === tab)))
      if (tab.dataset.mode === 'ask') {
        show('none') // hide all upload-flow views
        els.askSection.classList.remove('hidden')
      } else {
        els.askSection.classList.add('hidden')
        show('upload')
      }
    })
  })
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

  // The generate button now advances to the intent selection step.
  els.generate.addEventListener('click', () => show('intent'))
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
    const result = await generateContent({ uploadId: upload.id, childId: child.id, subject, viaParentSession, mode })

    if (mode === 'flashcards') {
      const [cards, guide] = await Promise.all([
        getFlashcards(upload.id, viaParentSession),
        getStudyGuide(upload.id, viaParentSession),
      ])
      if (!cards.length) throw new Error('No flashcards were generated. Try a clearer photo.')
      loadDeck(cards)
      renderGuide(guide)
      buildTest(cards)
      showResults('flashcards')
    } else if (mode === 'solve') {
      renderSolveResult(result.result)
      showResults('solve')
      showMascot("Think it through — you've got this.")
    } else if (mode === 'summarize') {
      renderSummarizeResult(result.result)
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

/** Show one of the upload-flow views; passing any other string hides them all. */
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
  els.generate.disabled = true
  show('upload')
}

$('#new-upload')?.addEventListener('click', resetToUpload)
$('#new-upload-solve')?.addEventListener('click', resetToUpload)
$('#new-upload-summarize')?.addEventListener('click', resetToUpload)

// ============================ Markdown renderer ============================
// Minimal safe markdown: escapes HTML first, then applies bold/italic/newlines.
// Only used on AI-generated text — the escapeHtml pass makes the substitutions safe.
function renderMd(text) {
  if (!text) return ''
  let out = escapeHtml(text)
  // Bold: **text**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  // Italic: *text* (not adjacent to other asterisks)
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  // Double newline → paragraph break; single newline → <br>
  out = out
    .split('\n\n')
    .map((p) => `<p class="ask-answer__para">${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
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
    <h3>First Step</h3>
    <p class="guide__summary">${escapeHtml(result.first_step || '')}</p>
    <h3>Think About This</h3>
    <p class="guide__summary" style="font-style:italic;color:var(--brand-ink)">${escapeHtml(result.guiding_question || '')}</p>`
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
    MathJax.typesetPromise([container]).catch(console.error)
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
/** Full history of this session's ask-thread exchanges. */
let conversationHistory = []

/** Compact plain-text summary of a result, used as the assistant's turn in history. */
function summariseForHistory(result) {
  const parts = []
  if (result.headline) parts.push(result.headline.replace(/\*\*/g, ''))
  if (result.answer) parts.push(result.answer.replace(/\*\*/g, ''))
  if (result.key_points?.length) parts.push(result.key_points.join('. '))
  return parts.join('\n\n')
}

/** Auto-send a follow-up question from a suggested chip. */
function fillFollowup(text) {
  els.askFollowupInput.value = text
  els.askFollowupBtn.disabled = false
  sendFollowup()
}

/** Append a Q/A exchange to the thread and scroll it into view. */
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

/** Switch from initial-input view to the thread+followup view. */
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

  // Hide previous "Dig deeper" chip sections
  els.askThread.querySelectorAll('.followup-chips').forEach((el) => {
    el.parentElement?.remove()
  })

  // Immediately show user bubble + loading placeholder before the API call
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

// ============================ Study guide ==============================
function renderGuide(guide) {
  const el = $('#guide-content')
  if (!guide) { el.innerHTML = '<p class="muted">No study guide was generated.</p>'; return }
  const g = guide.guide
  const concepts = (g.key_concepts || []).map((c) => `<li>${escapeHtml(c)}</li>`).join('')
  const practice = (g.practice_questions || []).map((p) => `<li>${escapeHtml(p)}</li>`).join('')
  el.innerHTML = `
    ${guide.subject ? `<span class="eyebrow">${escapeHtml(guide.subject)}</span>` : ''}
    <h3>Summary</h3>
    <p class="guide__summary">${escapeHtml(g.summary || '')}</p>
    ${concepts ? `<h3>Key concepts</h3><ul>${concepts}</ul>` : ''}
    ${practice ? `<h3>Practice questions</h3><ul>${practice}</ul>` : ''}`
}

// ============================ Self-test ==============================
let test = { cards: [], i: 0, revealed: false, correct: 0, total: 0 }
const testEl = $('#test-content')

function buildTest(cards) {
  test = { cards, i: 0, revealed: false, correct: 0, total: 0 }
  renderTest()
}

function renderTest() {
  if (test.i >= test.cards.length) {
    const pct = test.total ? Math.round((test.correct / test.total) * 100) : 0
    testEl.innerHTML = `
      <div style="text-align:center">
        <div class="score-big">${pct}%</div>
        <p class="muted">${test.correct} of ${test.total} correct</p>
        <button class="btn btn-primary" id="test-restart" style="margin-top:16px">Try again</button>
      </div>`
    $('#test-restart').addEventListener('click', () => buildTest(test.cards))
    return
  }
  const card = test.cards[test.i]
  testEl.innerHTML = `
    <p class="test-progress">Question ${test.i + 1} of ${test.cards.length}</p>
    <p class="flashcard-face__text" style="margin:10px 0 6px">${escapeHtml(card.question)}</p>
    ${test.revealed ? `<p class="guide__summary" style="margin-bottom:6px"><strong>Answer:</strong> ${escapeHtml(card.answer)}</p>` : ''}
    <div class="test-actions" id="test-actions"></div>`
  const actions = $('#test-actions')
  if (!test.revealed) {
    actions.innerHTML = `<button class="btn btn-primary" id="reveal">Show answer</button>`
    $('#reveal').addEventListener('click', () => { test.revealed = true; renderTest() })
  } else {
    actions.innerHTML = `
      <button class="btn btn-wrong" data-correct="0">✗ Got it wrong</button>
      <button class="btn btn-correct" data-correct="1">✓ Got it right</button>`
    actions.querySelectorAll('[data-correct]').forEach((b) =>
      b.addEventListener('click', () => mark(b.dataset.correct === '1', card)))
  }
}

async function mark(correct, card) {
  test.total += 1
  if (correct) test.correct += 1
  try { await recordQuizResult({ childId: child.id, flashcardId: card.id, correct, viaParentSession }) } catch { /* best effort */ }
  test.i += 1
  test.revealed = false
  renderTest()
}

// ============================ Tabs (flashcard results) =====================
function wireTabs() {
  $$('.seg [data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.seg [data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)))
      const which = tab.dataset.tab
      $('#panel-cards').classList.toggle('hidden', which !== 'cards')
      $('#panel-guide').classList.toggle('hidden', which !== 'guide')
      $('#panel-test').classList.toggle('hidden', which !== 'test')
    })
  })
}

main()

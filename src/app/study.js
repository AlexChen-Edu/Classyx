// Study interface: upload -> AI generate -> flashcards / guide / self-test,
// with a study timer that auto-saves to study_sessions.
import { supabase } from '../supabaseClient.js'
import { getActiveChild, getChildSession, setChildSession, getRememberedDevice, clearRememberedDevice } from './auth.js'
import {
  uploadNote, generateContent, getFlashcards, getStudyGuide,
  recordQuizResult, startSession, touchSession,
  startPresence, pingPresence, endPresenceBeacon, getChildStreak,
  saveChildSession, saveChildSessionBeacon,
} from './api.js'
import { $, $$, setStatus, loading, escapeHtml, computeStreak, renderStreakBadge } from './ui.js'

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
  generating: $('#generating'),
  results: $('#results'),
}

let chosenFile = null

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
        return picked
      }
    }
  }
  const childSession = getChildSession()
  if (childSession) {
    return { id: childSession.child_id, name: childSession.child_name, family_id: childSession.family_id }
  }
  const remembered = getRememberedDevice()
  if (remembered) {
    setChildSession({ child_id: remembered.child_id, child_name: remembered.child_name, family_id: remembered.family_id })
    return { id: remembered.child_id, name: remembered.child_name, family_id: remembered.family_id }
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
  wireTabs()
  wireForgetDevice()
  wireEndSession()
  renderStreak()
}

/**
 * Account-less children have no RLS access to study_sessions (anon has no
 * policy on that table at all — only the parent-authenticated path does),
 * so this throws for them; treated the same as "no streak yet" (0 days =
 * nothing shown), which is the correct UI anyway.
 */
async function renderStreak() {
  const slot = $('#streak-slot')
  if (!slot) return
  try {
    const sessions = await getChildStreak(child.id)
    slot.innerHTML = renderStreakBadge(computeStreak(sessions))
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
        if (sessionRow) await touchSession({ sessionId: sessionRow.id, startedAtMs })
      } else {
        await saveAnonSessionAwaited()
      }
    } catch { /* best effort */ }
    endPresence()
    location.href = CHILD_URL
    restore()
  })
}

// ============================ Timer / session ==============================
const INACTIVITY_MS = 5 * 60 * 1000

let sessionRow = null
let startedAtMs = Date.now()
let tickInterval = null
let saveInterval = null
let presenceInterval = null
let presenceEnded = false
let isPaused = false
let pausedAtMs = null
let totalPausedMs = 0

// Two independent reasons the timer can be paused — tab hidden, and no
// mouse/keyboard/scroll activity for 5 minutes. The timer only resumes once
// BOTH clear, so e.g. switching back to an already-inactive tab doesn't
// resume it.
let hiddenFlag = false
let inactiveFlag = false
let inactivityTimeout = null
let anonSessionSaved = false

async function startTimer() {
  startedAtMs = Date.now()
  totalPausedMs = 0
  els.timer.textContent = '0:00'
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
  document.addEventListener('visibilitychange', () => {
    hiddenFlag = document.hidden
    evalPause()
  })
  wireInactivityTracking()

  // Live presence for the parent dashboard's "Active now" indicator.
  try { await startPresence(child.id) } catch { /* best effort */ }
  startPresencePing()
  // pagehide fires both on real tab close and on normal in-app navigation
  // (e.g. clicking "Switch"), so this also ends presence on the latter.
  window.addEventListener('pagehide', endPresence)
  window.addEventListener('beforeunload', endPresence)
}

/** Tracks mouse/keyboard/scroll activity; auto-pauses after 5 minutes of none. */
function wireInactivityTracking() {
  const resetInactivity = () => {
    clearTimeout(inactivityTimeout)
    inactivityTimeout = setTimeout(() => {
      inactiveFlag = true
      evalPause()
    }, INACTIVITY_MS)
    if (inactiveFlag) {
      inactiveFlag = false
      evalPause()
    }
  }
  ;['mousemove', 'keydown', 'scroll', 'touchstart'].forEach((evt) =>
    window.addEventListener(evt, resetInactivity, { passive: true }))
  resetInactivity()
}

/** Pauses when either reason is active, resumes only once both have cleared. */
function evalPause() {
  const shouldPause = hiddenFlag || inactiveFlag
  if (shouldPause && !isPaused) pauseTimer()
  else if (!shouldPause && isPaused) resumeTimer()
}

function startTick() {
  tickInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startedAtMs) / 1000)
    els.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }, 1000)
}

function startPresencePing() {
  presenceInterval = setInterval(() => pingPresence(child.id, totalPausedMs).catch(() => {}), 30000)
}

/**
 * Tab switched away: stop the visible timer and stop pinging active_sessions
 * so the parent dashboard's "Active now" dot goes stale (and disappears
 * after 2 minutes per the staleness check) instead of staying lit while the
 * child isn't actually studying. One last ping fires immediately (instead of
 * waiting for the next 30s tick) so the dashboard's timer reflects the pause
 * within seconds rather than up to 30s late.
 */
function pauseTimer() {
  if (isPaused) return
  isPaused = true
  pausedAtMs = Date.now()
  clearInterval(tickInterval)
  clearInterval(presenceInterval)
  pingPresence(child.id, totalPausedMs).catch(() => {})
  saveSession()
}

/**
 * Tab back in view: shift startedAtMs forward by the time spent paused, so
 * that elapsed-time math (the on-screen timer and touchSession's duration
 * calc) never counts the paused gap, then resume the timer and presence
 * pings. The same paused duration is added to totalPausedMs, which is sent
 * as active_sessions.paused_ms so the parent dashboard — which only ever
 * sees the original started_at — can compute true active time as
 * (now - started_at) - paused_ms instead of raw wall-clock elapsed.
 */
function resumeTimer() {
  if (!isPaused) return
  isPaused = false
  const pauseDurationMs = Date.now() - pausedAtMs
  startedAtMs += pauseDurationMs
  totalPausedMs += pauseDurationMs
  pausedAtMs = null
  startTick()
  pingPresence(child.id, totalPausedMs).catch(() => {})
  startPresencePing()
}

function saveSession() {
  if (sessionRow) touchSession({ sessionId: sessionRow.id, startedAtMs })
}

/** Same calc touchSession uses internally, exposed here so the anon path can pass it explicitly. */
function elapsedMinutes() {
  return Math.max(0, Math.round((Date.now() - startedAtMs) / 60000))
}

/** Fire-and-forget; for pagehide/beforeunload, where an awaited call can't be trusted to finish. */
function saveAnonSessionBeacon() {
  if (anonSessionSaved || viaParentSession) return
  anonSessionSaved = true
  saveChildSessionBeacon({ childId: child.id, subject: els.subject.value || null, durationMinutes: elapsedMinutes() })
}

/** Awaited variant for the "End session" button, where we can show a loading state and wait. */
async function saveAnonSessionAwaited() {
  if (anonSessionSaved || viaParentSession) return
  anonSessionSaved = true
  await saveChildSession({ childId: child.id, subject: els.subject.value || null, durationMinutes: elapsedMinutes() })
}

function endPresence() {
  if (presenceEnded || !child) return
  presenceEnded = true
  clearInterval(presenceInterval)
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

  els.generate.addEventListener('click', generate)
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

async function generate() {
  if (!chosenFile) return
  const subject = els.subject.value || 'General'
  show('generating')
  try {
    const upload = await uploadNote({ child, file: chosenFile, subject })
    const result = await generateContent({ uploadId: upload.id, childId: child.id, subject })
    const [cards, guide] = await Promise.all([
      getFlashcards(upload.id),
      getStudyGuide(upload.id),
    ])
    if (!cards.length) throw new Error('No flashcards were generated. Try a clearer photo.')
    loadDeck(cards)
    renderGuide(guide)
    buildTest(cards)
    show('results')
  } catch (err) {
    show('upload')
    if (err.notConfigured) {
      setStatus(els.status, '', '')
      banner(`<div class="banner banner--info">${escapeHtml(err.message)}</div>`)
    } else {
      setStatus(els.status, err.message || 'Generation failed. Please try again.', 'error')
    }
  }
}

function banner(html) {
  // insert an info banner at the top of the upload section (once)
  const existing = $('#gen-banner')
  if (existing) existing.remove()
  const div = document.createElement('div')
  div.id = 'gen-banner'
  div.innerHTML = html
  els.uploadSection.prepend(div)
}

function show(view) {
  els.uploadSection.classList.toggle('hidden', view !== 'upload')
  els.generating.classList.toggle('hidden', view !== 'generating')
  els.results.classList.toggle('hidden', view !== 'results')
}

$('#new-upload')?.addEventListener('click', () => {
  chosenFile = null
  els.file.value = ''
  els.fileInfo.innerHTML = ''
  els.generate.disabled = true
  show('upload')
})

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
  try { await recordQuizResult({ childId: child.id, flashcardId: card.id, correct }) } catch { /* best effort */ }
  test.i += 1
  test.revealed = false
  renderTest()
}

// ============================ Tabs ==============================
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

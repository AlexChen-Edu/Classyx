// Study interface: upload -> AI generate -> flashcards / guide / self-test,
// with a study timer that auto-saves to study_sessions.
import { requireSession, getActiveChild } from './auth.js'
import {
  uploadNote, generateContent, getFlashcards, getStudyGuide,
  recordQuizResult, startSession, touchSession,
} from './api.js'
import { $, $$, setStatus, loading, escapeHtml } from './ui.js'

const MAX_BYTES = 10 * 1024 * 1024

const child = getActiveChild()
if (!child) location.replace('/app/child.html')

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

async function main() {
  const session = await requireSession()
  if (!session || !child) return
  els.childName.textContent = child.name
  startTimer()
  wireUpload()
  wireTabs()
}

// ============================ Timer / session ==============================
let sessionRow = null
let startedAtMs = Date.now()
let tickInterval = null
let saveInterval = null

async function startTimer() {
  startedAtMs = Date.now()
  els.timer.textContent = '0:00'
  tickInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startedAtMs) / 1000)
    els.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }, 1000)
  try {
    sessionRow = await startSession({ childId: child.id, subject: els.subject.value || null })
  } catch { /* timer still shows; we just won't persist if this failed */ }
  // Auto-save every 60s so progress survives an abrupt close.
  saveInterval = setInterval(saveSession, 60000)
  window.addEventListener('pagehide', saveSession)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSession()
  })
}

function saveSession() {
  if (sessionRow) touchSession({ sessionId: sessionRow.id, startedAtMs })
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

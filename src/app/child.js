// Profile selector + code gate. Reached either via a parent's authenticated
// session (e.g. the magic link) — shows the family's profile grid, scoped by
// RLS — OR by an account-less visitor who picked "I'm a student" on the login
// page, who instead redeems a code directly via the anon-safe
// redeem_child_code RPC. This page must stay reachable WITHOUT being logged
// in, so it never calls requireSession() (which would redirect them away).
import { supabase, supabaseAnon } from '../supabaseClient.js'
import {
  signOut, setActiveChild, setChildSession,
  getRememberedDevice, setRememberedDevice, clearRememberedDevice, clearChildSession, clearActiveChild,
  getStudyRecency,
} from './auth.js'
import { listChildren, verifyChildPin, setChildPin, generateChildCode } from './api.js'
import { $, $$, setStatus, escapeHtml, initials, tintFor, friendlyMessage } from './ui.js'

const STUDY = '/app/study.html'
const LOGIN = '/app/login.html'
const welcomeBack = $('#welcome-back')
const codeGate = $('#code-gate')
const roleFork = $('#role-fork')
const confirmStart = $('#confirm-start')
const confirmAvatar = $('#confirm-avatar')
const confirmName = $('#confirm-name')
const welcomeAvatar = $('#welcome-avatar')
const welcomeName = $('#welcome-name')
const profilesEl = $('#profiles')
const anonSection = $('#anon-code-section')
const anonBoxes = $$('.pin-box', $('#anon-pin-inputs'))
const anonStatus = $('[data-anon-status]')
const overlay = $('#pin-overlay')
const pinBoxes = $$('.pin-box', overlay)
const pinStatus = $('[data-status]', overlay)
const pinSub = $('#pin-sub')
$('[data-signout]')?.addEventListener('click', signOut)
$('#pin-cancel')?.addEventListener('click', closePin)
$('#welcome-start')?.addEventListener('click', startFromRememberedDevice)
$('#welcome-switch')?.addEventListener('click', switchProfile)
$('#fork-student')?.addEventListener('click', showAnonCodeEntry)
$('#fork-adult')?.addEventListener('click', () => { location.href = LOGIN })
$('#confirm-go')?.addEventListener('click', () => { location.href = STUDY })
$('#confirm-not-you')?.addEventListener('click', notYou)

let activeCandidate = null

async function main() {
  // Account-less child, remembered on this device — skip straight past the
  // code entry form entirely. This only ever applies on a tab with no parent
  // session: a signed-in parent always sees the normal family profile grid.
  const remembered = getRememberedDevice()
  if (remembered) {
    showWelcomeBack(remembered)
    return
  }
  await showCodeGate()
}

/** The normal profile grid (parent session) or role fork (account-less) view. */
async function showCodeGate() {
  if (!supabase) {
    profilesEl.innerHTML = `<div class="empty" style="margin-top:20px"><p class="muted">No profiles yet.</p></div>`
    return
  }
  // Listing children is RLS-scoped to an authenticated parent's family, so an
  // account-less visitor can't use that grid at all — offer the student/adult
  // fork instead. The page itself never redirects them away.
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    codeGate.classList.add('hidden')
    roleFork.classList.remove('hidden')
    return
  }
  try {
    const children = await listChildren()
    renderProfiles(children)
  } catch (err) {
    profilesEl.innerHTML = `<div class="banner banner--error">${escapeHtml(friendlyMessage(err, 'Could not load profiles. Try again.'))}</div>`
  }
}

/** "I'm a student" on the role fork — reveals the code entry form. */
function showAnonCodeEntry() {
  roleFork.classList.add('hidden')
  codeGate.classList.remove('hidden')
  profilesEl.innerHTML = ''
  anonSection.classList.remove('hidden')
  anonBoxes.forEach((b) => (b.value = ''))
  anonBoxes[0].focus()
}

/** "Ready to study, NAME?" shown after a code/PIN is verified, before the
 *  redirect to study.html. By this point setActiveChild/setChildSession has
 *  already run, so "Start study session" is just a navigation. */
function showConfirmStart(child) {
  welcomeBack.classList.add('hidden')
  codeGate.classList.add('hidden')
  roleFork.classList.add('hidden')
  overlay.hidden = true
  confirmAvatar.textContent = initials(child.name)
  confirmAvatar.style.background = tintFor(child.name)
  confirmName.textContent = `Ready to study, ${child.name}?`
  confirmStart.classList.remove('hidden')
}

function notYou() {
  clearRememberedDevice()
  clearChildSession()
  clearActiveChild()
  location.reload()
}

// --- Remembered device ("Welcome back") -------------------------------------
function showWelcomeBack(remembered) {
  welcomeAvatar.textContent = initials(remembered.child_name)
  welcomeAvatar.style.background = tintFor(remembered.child_name)
  welcomeName.textContent = `Welcome back, ${remembered.child_name} 👋`
  renderStreakRiskBadge(remembered.child_id)
  codeGate.classList.add('hidden')
  welcomeBack.classList.remove('hidden')
}

/** Loss-aversion nudge: warn if yesterday was skipped, or confirm today's already in progress. */
function renderStreakRiskBadge(childId) {
  $('#welcome-streak-risk')?.remove()
  const { today, yesterday } = getStudyRecency(childId)
  let html = ''
  if (today) {
    html = `<p id="welcome-streak-risk" class="streak-risk-badge streak-risk-badge--ok">✓ Goal in progress</p>`
  } else if (!yesterday) {
    html = `<p id="welcome-streak-risk" class="streak-risk-badge streak-risk-badge--warn">⚠️ Streak at risk — study today to keep it alive!</p>`
  }
  if (html) welcomeAvatar.insertAdjacentHTML('afterend', html)
}

function startFromRememberedDevice() {
  const remembered = getRememberedDevice()
  if (!remembered) { switchProfile(); return }
  setChildSession({
    child_id: remembered.child_id, child_name: remembered.child_name, family_id: remembered.family_id,
    daily_goal_minutes: remembered.daily_goal_minutes,
  })
  location.href = STUDY
}

function switchProfile() {
  clearRememberedDevice()
  welcomeBack.classList.add('hidden')
  codeGate.classList.remove('hidden')
  showCodeGate()
}

// --- Account-less code entry (redeem_child_code) ----------------------------
anonBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/[^a-z0-9]/gi, '').slice(0, 1).toLowerCase()
    if (box.value && i < anonBoxes.length - 1) anonBoxes[i + 1].focus()
    if (anonBoxes.every((b) => b.value)) redeemCode()
  })
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) anonBoxes[i - 1].focus()
  })
})

async function redeemCode() {
  const code = anonBoxes.map((b) => b.value).join('')
  if (code.length !== 6 || !supabaseAnon) return
  setStatus(anonStatus, 'Checking…')
  try {
    const { data, error } = await supabaseAnon.rpc('redeem_child_code', { code })
    if (error) throw error
    const row = data?.[0]
    if (!row) throw new Error('Invalid or expired code')
    // Clear immediately so the code is no longer visible on screen.
    anonBoxes.forEach((b) => (b.value = ''))
    const { child_id, child_name, family_id, daily_goal_minutes } = row
    setChildSession({ child_id, child_name, family_id, daily_goal_minutes })
    setRememberedDevice({ child_id, child_name, family_id, daily_goal_minutes })
    showConfirmStart({ id: child_id, name: child_name, family_id })
  } catch (err) {
    setStatus(anonStatus, friendlyCodeError(err), 'error')
    anonBoxes.forEach((b) => (b.value = ''))
    anonBoxes[0].focus()
  }
}

function friendlyCodeError(err) {
  const m = err?.message || ''
  if (/invalid or expired/i.test(m)) return 'Incorrect code. Try again.'
  return m || 'Could not verify code.'
}

function renderProfiles(children) {
  if (!children.length) {
    profilesEl.innerHTML = `
      <div class="empty" style="margin-top:20px">
        <p class="muted" style="margin-bottom:16px">No profiles yet.</p>
        <a class="btn btn-primary" href="/app/add-child.html">+ Add a child</a>
      </div>`
    return
  }
  profilesEl.innerHTML = children.map((c) => `
    <button class="profile-btn" data-id="${c.id}">
      <span class="avatar-lg" style="background:${tintFor(c.name)}">${escapeHtml(initials(c.name))}</span>
      <span>${escapeHtml(c.name)}</span>
    </button>`).join('')

  profilesEl.querySelectorAll('.profile-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectChild(children.find((c) => c.id === btn.dataset.id)))
  })
}

async function selectChild(child) {
  activeCandidate = child
  // verify('') is true only when no PIN is set -> open profile, skip the gate.
  try {
    if (await verifyChildPin(child.id, '')) {
      enter(child)
      return
    }
  } catch { /* fall through to PIN prompt */ }
  openPin(child)
}

function enter(child) {
  setActiveChild(child)
  showConfirmStart(child)
}

// --- Code modal ---
function openPin(child) {
  pinSub.textContent = `Enter ${child.name}'s 6-character code`
  setStatus(pinStatus, '')
  pinBoxes.forEach((b) => (b.value = ''))
  overlay.hidden = false
  pinBoxes[0].focus()
}

function closePin() {
  overlay.hidden = true
  activeCandidate = null
}

pinBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/[^a-z0-9]/gi, '').slice(0, 1).toLowerCase()
    if (box.value && i < pinBoxes.length - 1) pinBoxes[i + 1].focus()
    if (pinBoxes.every((b) => b.value)) submitPin()
  })
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) pinBoxes[i - 1].focus()
  })
})

async function submitPin() {
  if (!activeCandidate) return
  const code = pinBoxes.map((b) => b.value).join('')
  if (code.length !== 6) return
  setStatus(pinStatus, 'Checking…')
  try {
    const ok = await verifyChildPin(activeCandidate.id, code)
    if (ok) {
      // Clear immediately so the code is no longer visible on screen.
      pinBoxes.forEach((b) => (b.value = ''))
      const child = activeCandidate
      // Silently rotate the code in the background so this one can never be
      // reused. Awaited (but invisible — no status shown) so it completes
      // before navigation tears the page down.
      await rotateChildCode(child.id)
      enter(child)
    } else {
      setStatus(pinStatus, 'Incorrect code. Try again.', 'error')
      pinBoxes.forEach((b) => (b.value = ''))
      pinBoxes[0].focus()
    }
  } catch (err) {
    setStatus(pinStatus, friendlyMessage(err, 'Could not verify code.'), 'error')
  }
}

async function rotateChildCode(childId) {
  try {
    await setChildPin(childId, generateChildCode())
  } catch { /* best effort — a failed rotation just leaves the old code valid */ }
}

main()

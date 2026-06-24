// Profile selector + code gate. Reached either via a parent's authenticated
// session (e.g. the magic link) — shows the family's profile grid, scoped by
// RLS — OR by an account-less visitor who picked "I'm a student" on the login
// page, who instead redeems a code directly via the anon-safe
// redeem_child_code RPC. This page must stay reachable WITHOUT being logged
// in, so it never calls requireSession() (which would redirect them away).
import { supabase, supabaseAnon } from '../supabaseClient.js'
import { signOut, setActiveChild, setChildSession } from './auth.js'
import { listChildren, verifyChildPin, setChildPin, generateChildCode } from './api.js'
import { $, $$, setStatus, escapeHtml, initials, tintFor } from './ui.js'

const STUDY = '/app/study.html'
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

let activeCandidate = null

async function main() {
  if (!supabase) {
    profilesEl.innerHTML = `<div class="empty" style="margin-top:20px"><p class="muted">No profiles yet.</p></div>`
    return
  }
  // Listing children is RLS-scoped to an authenticated parent's family, so an
  // account-less visitor can't use that grid at all — show the direct code
  // entry instead. The page itself never redirects them away.
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    profilesEl.innerHTML = ''
    anonSection.classList.remove('hidden')
    anonBoxes[0].focus()
    return
  }
  try {
    const children = await listChildren()
    renderProfiles(children)
  } catch (err) {
    profilesEl.innerHTML = `<div class="banner banner--error">${escapeHtml(err.message)}</div>`
  }
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
    setChildSession({ child_id: row.child_id, child_name: row.child_name, family_id: row.family_id })
    location.href = STUDY
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
  location.href = STUDY
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
    setStatus(pinStatus, err.message || 'Could not verify code.', 'error')
  }
}

async function rotateChildCode(childId) {
  try {
    await setChildPin(childId, generateChildCode())
  } catch { /* best effort — a failed rotation just leaves the old code valid */ }
}

main()

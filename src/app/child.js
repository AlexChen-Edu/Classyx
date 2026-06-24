// Profile selector + PIN gate. Students land here from the magic link.
import { requireSession, signOut, setActiveChild } from './auth.js'
import { listChildren, verifyChildPin } from './api.js'
import { $, $$, setStatus, escapeHtml, initials, tintFor } from './ui.js'

const STUDY = '/app/study.html'
const profilesEl = $('#profiles')
const overlay = $('#pin-overlay')
const pinBoxes = $$('.pin-box', overlay)
const pinStatus = $('[data-status]', overlay)
const pinSub = $('#pin-sub')
$('[data-signout]')?.addEventListener('click', signOut)
$('#pin-cancel')?.addEventListener('click', closePin)

let activeCandidate = null

async function main() {
  const session = await requireSession()
  if (!session) return
  try {
    const children = await listChildren()
    renderProfiles(children)
  } catch (err) {
    profilesEl.innerHTML = `<div class="banner banner--error">${escapeHtml(err.message)}</div>`
  }
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

// --- PIN modal ---
function openPin(child) {
  pinSub.textContent = `Enter ${child.name}'s 4-digit PIN`
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
    box.value = box.value.replace(/\D/g, '')
    if (box.value && i < pinBoxes.length - 1) pinBoxes[i + 1].focus()
    if (pinBoxes.every((b) => b.value)) submitPin()
  })
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) pinBoxes[i - 1].focus()
  })
})

async function submitPin() {
  if (!activeCandidate) return
  const pin = pinBoxes.map((b) => b.value).join('')
  if (pin.length !== 4) return
  setStatus(pinStatus, 'Checking…')
  try {
    const ok = await verifyChildPin(activeCandidate.id, pin)
    if (ok) {
      enter(activeCandidate)
    } else {
      setStatus(pinStatus, 'Incorrect PIN. Try again.', 'error')
      pinBoxes.forEach((b) => (b.value = ''))
      pinBoxes[0].focus()
    }
  } catch (err) {
    setStatus(pinStatus, err.message || 'Could not verify PIN.', 'error')
  }
}

main()

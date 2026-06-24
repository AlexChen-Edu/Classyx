// Parent creates a child profile and sets its 4-digit PIN.
import { requireSession, signOut } from './auth.js'
import { createChild, setChildPin } from './api.js'
import { $, setStatus, loading } from './ui.js'

$('[data-signout]')?.addEventListener('click', signOut)

const form = $('#child-form')
const nameEl = $('#name')
const gradeEl = $('#grade')
const pinEl = $('#pin')
const submitBtn = $('#submit')
const statusEl = $('[data-status]')

// keep PIN numeric only
pinEl.addEventListener('input', () => {
  pinEl.value = pinEl.value.replace(/\D/g, '').slice(0, 4)
})

// Redirect to login if there's no session (no top-level await — keeps the
// production build target happy).
requireSession()

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = nameEl.value.trim()
  const pin = pinEl.value
  if (!name) return setStatus(statusEl, 'Please enter a name.', 'error')
  if (!/^[0-9]{4}$/.test(pin)) return setStatus(statusEl, 'PIN must be exactly 4 digits.', 'error')

  const restore = loading(submitBtn, 'Creating…')
  setStatus(statusEl, '')
  try {
    const child = await createChild({ name, grade: gradeEl.value })
    await setChildPin(child.id, pin)
    location.href = '/app/dashboard.html'
  } catch (err) {
    setStatus(statusEl, err.message || 'Could not create the profile.', 'error')
    restore()
  }
})

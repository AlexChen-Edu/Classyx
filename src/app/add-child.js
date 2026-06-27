// Parent creates a child profile. A 6-character access code is generated
// automatically and shown once, right after creation.
import { requireSession, signOut } from './auth.js'
import { createChild, setChildPin, generateChildCode } from './api.js'
import { $, setStatus, loading } from './ui.js'

$('[data-signout]')?.addEventListener('click', signOut)

const form = $('#child-form')
const nameEl = $('#name')
const gradeEl = $('#grade')
const submitBtn = $('#submit')
const statusEl = $('[data-status]')
const formCard = $('#form-card')
const codeCard = $('#code-card')
const codeValueEl = $('#code-value')

// Redirect to login if there's no session, or to child.html if the signed-in
// user isn't a parent (no top-level await — keeps the production build
// target happy).
;(async () => {
  const session = await requireSession()
  if (!session) return
  const role = session.user.user_metadata?.role
  if (role !== 'parent' && role !== 'self') {
    location.replace('/app/child.html')
  }
})()

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = nameEl.value.trim()
  if (!name) return setStatus(statusEl, 'Please enter a name.', 'error')

  const restore = loading(submitBtn, 'Creating…')
  setStatus(statusEl, '')
  try {
    const child = await createChild({ name, grade: gradeEl.value })
    const code = generateChildCode()
    await setChildPin(child.id, code)
    codeValueEl.textContent = code
    formCard.classList.add('hidden')
    codeCard.classList.remove('hidden')
  } catch (err) {
    setStatus(statusEl, err.message || 'Could not create the profile.', 'error')
    restore()
  }
})

$('#code-done').addEventListener('click', () => {
  location.href = '/app/dashboard.html'
})

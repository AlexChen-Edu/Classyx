// Handles the link from resetPasswordForEmail. Supabase's client detects the
// recovery token in the URL and establishes a session automatically — if
// that didn't happen (expired/missing link), there's no session to update.
import { supabase } from '../supabaseClient.js'
import { $, setStatus, loading } from './ui.js'

const LOGIN = '/app/login.html'
const MIN_SCORE = 3 // same bar as signup

const form = $('#reset-form')
const passwordEl = $('#password')
const confirmEl = $('#confirm')
const submitBtn = $('#submit')
const statusEl = $('[data-status]')
const strengthBox = $('#strength')
const strengthFill = $('#strength-fill')
const strengthLabel = $('#strength-label')
const strengthReqs = $('#strength-reqs')
const matchHint = $('#match-hint')

if (!supabase) {
  setStatus(statusEl, 'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.', 'error')
  form.querySelectorAll('input, button').forEach((el) => (el.disabled = true))
}

function wirePasswordToggle(inputEl, buttonEl) {
  buttonEl.addEventListener('click', () => {
    const showing = inputEl.type === 'text'
    inputEl.type = showing ? 'password' : 'text'
    buttonEl.setAttribute('aria-pressed', String(!showing))
    buttonEl.setAttribute('aria-label', showing ? 'Show password' : 'Hide password')
    buttonEl.querySelector('.eye-open').classList.toggle('hidden', !showing)
    buttonEl.querySelector('.eye-closed').classList.toggle('hidden', showing)
  })
}
wirePasswordToggle(passwordEl, $('#password-toggle'))
wirePasswordToggle(confirmEl, $('#confirm-toggle'))

function evaluate(pw) {
  let score = 0
  const reqs = []
  if (pw.length >= 8) score++; else reqs.push('8+ characters')
  if (pw.length >= 12) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++; else reqs.push('upper & lowercase')
  if (/[0-9]/.test(pw)) score++; else reqs.push('a number')
  if (/[^A-Za-z0-9]/.test(pw)) score++; else reqs.push('a symbol')
  const labels = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong']
  return { score, label: labels[score] || '', reqs }
}

function renderStrength() {
  const pw = passwordEl.value
  const { score, label, reqs } = evaluate(pw)
  strengthBox.dataset.score = String(score)
  strengthFill.style.width = `${(score / 5) * 100}%`
  if (!pw) {
    strengthLabel.textContent = '—'
    strengthReqs.textContent = ''
  } else {
    strengthLabel.textContent = label
    strengthReqs.textContent = reqs.length ? `Add: ${reqs.join(', ')}` : 'Looks good ✓'
  }
}

function renderMatch() {
  if (!confirmEl.value) {
    matchHint.textContent = ''
    return
  }
  if (passwordEl.value === confirmEl.value) {
    matchHint.textContent = 'Passwords match ✓'
    matchHint.style.color = 'var(--success)'
  } else {
    matchHint.textContent = "Passwords don't match"
    matchHint.style.color = 'var(--notice)'
  }
}

function refreshSubmit() {
  const ok = evaluate(passwordEl.value).score >= MIN_SCORE &&
    passwordEl.value === confirmEl.value && confirmEl.value.length > 0
  submitBtn.disabled = !ok
}

passwordEl.addEventListener('input', () => { renderStrength(); renderMatch(); refreshSubmit() })
confirmEl.addEventListener('input', () => { renderMatch(); refreshSubmit() })

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const pw = passwordEl.value
  if (evaluate(pw).score < MIN_SCORE) {
    setStatus(statusEl, 'Please choose a stronger password.', 'error')
    return
  }
  if (pw !== confirmEl.value) {
    setStatus(statusEl, "Passwords don't match.", 'error')
    return
  }
  const restore = loading(submitBtn, 'Updating…')
  setStatus(statusEl, '')
  try {
    const { error } = await supabase.auth.updateUser({ password: pw })
    if (error) throw error
    setStatus(statusEl, 'Password updated. Redirecting to sign in…', 'success')
    setTimeout(() => location.replace(LOGIN), 1500)
  } catch (err) {
    setStatus(statusEl, err.message || 'Could not update your password. The link may have expired.', 'error')
    restore()
  }
})

// The recovery link's session is established asynchronously by the Supabase
// client as the page loads — without it, updateUser() has nothing to act on.
;(async () => {
  if (!supabase) return
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    setStatus(statusEl, 'This reset link is invalid or has expired. Request a new one from the sign in page.', 'error')
    form.querySelectorAll('input, button').forEach((el) => (el.disabled = true))
  }
})()

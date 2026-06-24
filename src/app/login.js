// Parent auth.
//  - Sign in: email + password in one step.
//  - Create account: step 1 = email + "Continue with email"; step 2 = password
//    (with a live strength check) + confirm password.
//  - Magic link: passwordless sign-in link.
import { supabase } from '../supabaseClient.js'
import { $, setStatus, loading } from './ui.js'

const DASHBOARD = '/app/dashboard.html'
const CHILD = '/app/child.html'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_SCORE = 3 // minimum "Good" rating required to create an account
const TURNSTILE_SITE_KEY = '0x4AAAAAADpSfVDp1j7V2mzn' // same widget as the waitlist form

const form = $('#auth-form')
const emailEl = $('#email')
const passwordEl = $('#password')
const confirmEl = $('#confirm')
const passwordSection = $('#password-section')
const strengthBox = $('#strength')
const strengthFill = $('#strength-fill')
const strengthLabel = $('#strength-label')
const strengthReqs = $('#strength-reqs')
const confirmRow = $('#confirm-row')
const matchHint = $('#match-hint')
const turnstileRow = $('#turnstile-row')
const turnstileWidget = $('#turnstile-widget')
const submitBtn = $('#submit')
const statusEl = $('[data-status]')
const magicBtn = $('#magic-link')

let mode = 'signin' // 'signin' | 'signup'
let signupStep = 'email' // 'email' | 'password' (signup only)
let turnstileToken = null
let turnstileWidgetId = null

if (!supabase) {
  setStatus(statusEl, 'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.', 'error')
  form.querySelectorAll('input, button').forEach((el) => (el.disabled = true))
  magicBtn.disabled = true
}

// Already signed in? Skip straight to the dashboard.
;(async () => {
  if (!supabase) return
  const { data: { session } } = await supabase.auth.getSession()
  if (session) location.replace(DASHBOARD)
})()

// --- Password strength ------------------------------------------------------
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

function refreshCreateButton() {
  if (mode === 'signup' && signupStep === 'password') {
    const ok = evaluate(passwordEl.value).score >= MIN_SCORE &&
      passwordEl.value === confirmEl.value && confirmEl.value.length > 0 &&
      !!turnstileToken
    submitBtn.disabled = !ok
  } else {
    submitBtn.disabled = false
  }
}

// --- View state -------------------------------------------------------------
const hide = (el) => el.classList.add('hidden')
const showEl = (el) => el.classList.remove('hidden')

// --- Cloudflare Turnstile (Create account only) -----------------------------
// Rendered explicitly (not via data-sitekey) so a callback can capture the
// token and gate the submit button on it.
function waitForTurnstile() {
  return new Promise((resolve) => {
    if (window.turnstile) return resolve(window.turnstile)
    const interval = setInterval(() => {
      if (window.turnstile) {
        clearInterval(interval)
        resolve(window.turnstile)
      }
    }, 100)
  })
}

function activateTurnstile() {
  showEl(turnstileRow)
  turnstileToken = null
  refreshCreateButton()
  if (turnstileWidgetId !== null) {
    window.turnstile?.reset(turnstileWidgetId)
    return
  }
  waitForTurnstile().then((ts) => {
    turnstileWidgetId = ts.render(turnstileWidget, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => { turnstileToken = token; refreshCreateButton() },
      'expired-callback': () => { turnstileToken = null; refreshCreateButton() },
      'error-callback': () => { turnstileToken = null; refreshCreateButton() },
    })
  })
}

function resetTurnstile() {
  hide(turnstileRow)
  turnstileToken = null
  if (turnstileWidgetId !== null) window.turnstile?.reset(turnstileWidgetId)
}

function applyMode() {
  setStatus(statusEl, '')
  passwordEl.value = ''
  confirmEl.value = ''
  renderStrength()
  renderMatch()

  if (mode === 'signin') {
    showEl(passwordSection)
    hide(strengthBox)
    hide(confirmRow)
    resetTurnstile()
    passwordEl.autocomplete = 'current-password'
    submitBtn.textContent = 'Sign in'
    submitBtn.disabled = false
  } else {
    signupStep = 'email'
    applySignupStep()
  }
}

function applySignupStep() {
  if (signupStep === 'email') {
    hide(passwordSection) // no password field in the first signup screen
    resetTurnstile()
    submitBtn.textContent = 'Continue with email'
    submitBtn.disabled = false
  } else {
    showEl(passwordSection)
    showEl(strengthBox)
    showEl(confirmRow)
    activateTurnstile()
    passwordEl.autocomplete = 'new-password'
    submitBtn.textContent = 'Create account'
    renderStrength()
    refreshCreateButton()
    passwordEl.focus()
  }
}

// --- Tabs -------------------------------------------------------------------
document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode
    document.querySelectorAll('.auth-tab').forEach((t) =>
      t.setAttribute('aria-selected', String(t === tab)),
    )
    applyMode()
  })
})

passwordEl.addEventListener('input', () => {
  if (mode === 'signup' && signupStep === 'password') {
    renderStrength()
    renderMatch()
    refreshCreateButton()
  }
})
confirmEl.addEventListener('input', () => {
  renderMatch()
  refreshCreateButton()
})

// --- Submit -----------------------------------------------------------------
form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = emailEl.value.trim()

  if (mode === 'signin') return doSignIn(email, passwordEl.value)

  // Create account
  if (signupStep === 'email') {
    if (!EMAIL_RE.test(email)) {
      setStatus(statusEl, 'Enter a valid email address.', 'error')
      return
    }
    signupStep = 'password'
    setStatus(statusEl, '')
    applySignupStep()
    return
  }

  // signupStep === 'password'
  const pw = passwordEl.value
  if (evaluate(pw).score < MIN_SCORE) {
    setStatus(statusEl, 'Please choose a stronger password.', 'error')
    return
  }
  if (pw !== confirmEl.value) {
    setStatus(statusEl, "Passwords don't match.", 'error')
    return
  }
  if (!turnstileToken) {
    setStatus(statusEl, 'Please complete the verification challenge.', 'error')
    return
  }
  await doSignUp(email, pw, turnstileToken)
})

async function doSignIn(email, password) {
  if (!EMAIL_RE.test(email) || password.length < 8) {
    setStatus(statusEl, 'Enter a valid email and a password of at least 8 characters.', 'error')
    return
  }
  const restore = loading(submitBtn, 'Signing in…')
  setStatus(statusEl, '')
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    location.replace(DASHBOARD)
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
    restore()
  }
}

async function doSignUp(email, password, turnstileToken) {
  const restore = loading(submitBtn, 'Creating…')
  setStatus(statusEl, '')
  try {
    // Captured for the record alongside the account; server-side verification
    // (calling Cloudflare's siteverify endpoint, as send-confirmation does for
    // the waitlist) is not wired up yet.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { turnstile_token: turnstileToken } },
    })
    if (error) throw error
    if (data.session) {
      location.replace(DASHBOARD)
    } else {
      setStatus(statusEl, 'Account created! Check your email to confirm, then sign in.', 'success')
      restore()
    }
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
    restore()
    activateTurnstile() // token may be stale/used — force a fresh challenge before retrying
  }
}

magicBtn.addEventListener('click', async () => {
  const email = emailEl.value.trim()
  if (!EMAIL_RE.test(email)) {
    setStatus(statusEl, 'Enter your email first, then request a link.', 'error')
    emailEl.focus()
    return
  }
  const restore = loading(magicBtn, 'Sending…')
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}${CHILD}` },
    })
    if (error) throw error
    setStatus(statusEl, 'Check your email for a sign-in link.', 'success')
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
  } finally {
    restore()
  }
})

function friendly(err) {
  const m = err?.message || 'Something went wrong.'
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password.'
  if (/already registered/i.test(m)) return 'That email already has an account — try signing in.'
  return m
}

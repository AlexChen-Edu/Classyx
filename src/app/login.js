// Parent auth.
//  - Sign in: email + password in one step.
//  - Create account: step 1 = email + "Continue with email"; step 2 = role
//    selection (just me / student / parent); step 3 = password (with a live
//    strength check) + confirm password. Picking "student" skips account
//    creation entirely and redirects to the code-entry page.
import { supabase, supabaseAnon } from '../supabaseClient.js'
import { setChildSession, getFamily } from './auth.js'
import { $, $$, setStatus, loading } from './ui.js'

const DASHBOARD = '/app/dashboard.html'
const CHILD = '/app/child.html'
const STUDY = '/app/study.html'
const VERIFY = '/app/verify.html'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_SCORE = 3 // minimum "Good" rating required to create an account
const TURNSTILE_SITE_KEY = '0x4AAAAAADpSfVDp1j7V2mzn' // same widget as the waitlist form

const form = $('#auth-form')
const emailEl = $('#email')
const passwordEl = $('#password')
const confirmEl = $('#confirm')
const roleStep = $('#role-step')
const roleCards = $$('.role-card')
const roleBackBtn = $('#role-back')
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
const googleBtn = $('#google-signin')
const signupConsent = $('#signup-consent')
const forgotPasswordRow = $('#forgot-password-row')

let mode = 'signin' // 'signin' | 'signup'
let signupStep = 'email' // 'email' | 'role' | 'password' (signup only)
let selectedRole = null // 'self' | 'parent' (signup only — 'kid' redirects immediately)
let turnstileToken = null
let turnstileWidgetId = null
// Guards against a race: the kid-card click navigates synchronously, but the
// already-signed-in check below is async and could otherwise resolve after
// the click and override the navigation (e.g. a parent still signed in on a
// shared device, then a kid clicks "I'm a student").
let navigatingAway = false

// --- Show/hide password toggles ---------------------------------------------
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
function resetPasswordVisibility(buttonEl, inputEl) {
  inputEl.type = 'password'
  buttonEl.setAttribute('aria-pressed', 'false')
  buttonEl.setAttribute('aria-label', 'Show password')
  buttonEl.querySelector('.eye-open').classList.remove('hidden')
  buttonEl.querySelector('.eye-closed').classList.add('hidden')
}
wirePasswordToggle(passwordEl, $('#password-toggle'))
wirePasswordToggle(confirmEl, $('#confirm-toggle'))

if (!supabase) {
  setStatus(statusEl, 'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.', 'error')
  form.querySelectorAll('input, button').forEach((el) => (el.disabled = true))
  googleBtn.disabled = true
}

// Already signed in? Skip straight to the dashboard.
;(async () => {
  if (!supabase) return
  const { data: { session } } = await supabase.auth.getSession()
  if (session && !navigatingAway) location.replace(DASHBOARD)
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

function setRoleSelection(role) {
  roleCards.forEach((card) => {
    const selected = card === role
    card.classList.toggle('is-selected', selected)
    card.setAttribute('aria-pressed', String(selected))
  })
}

function applyMode() {
  setStatus(statusEl, '')
  passwordEl.value = ''
  confirmEl.value = ''
  resetPasswordVisibility($('#password-toggle'), passwordEl)
  resetPasswordVisibility($('#confirm-toggle'), confirmEl)
  renderStrength()
  renderMatch()
  selectedRole = null
  setRoleSelection(null)

  if (mode === 'signin') {
    showEl(passwordSection)
    hide(strengthBox)
    hide(confirmRow)
    hide(roleStep)
    showEl(submitBtn)
    hide(signupConsent)
    showEl(forgotPasswordRow)
    resetTurnstile()
    passwordEl.autocomplete = 'current-password'
    submitBtn.textContent = 'Sign in'
    submitBtn.disabled = false
  } else {
    showEl(signupConsent)
    hide(forgotPasswordRow)
    signupStep = 'email'
    applySignupStep()
  }
}

function applySignupStep() {
  hide(roleStep)
  showEl(submitBtn)

  if (signupStep === 'email') {
    hide(passwordSection) // no password field in the first signup screen
    resetTurnstile()
    submitBtn.textContent = 'Continue with email'
    submitBtn.disabled = false
  } else if (signupStep === 'role') {
    hide(passwordSection)
    hide(submitBtn) // the cards themselves drive the next step, not this button
    resetTurnstile() // Turnstile must not appear until the password step
    showEl(roleStep)
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

// --- Role selection ----------------------------------------------------------
roleCards.forEach((card) => {
  card.addEventListener('click', () => {
    const role = card.dataset.role
    if (role === 'kid') {
      // No account at all — straight to the code-entry page. Set the guard
      // first so the async signed-in check above can't race this and bounce
      // to the dashboard instead.
      navigatingAway = true
      location.href = CHILD
      return
    }
    selectedRole = role
    setRoleSelection(card)
    signupStep = 'password'
    setStatus(statusEl, '')
    applySignupStep()
  })
})

roleBackBtn.addEventListener('click', () => {
  signupStep = 'email'
  setStatus(statusEl, '')
  applySignupStep()
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
    signupStep = 'role'
    setStatus(statusEl, '')
    applySignupStep()
    return
  }

  if (signupStep === 'role') {
    // Role is chosen via the cards themselves; an accidental Enter-key submit
    // here (e.g. from the still-visible email field) does nothing.
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
  await doSignUp(email, pw, turnstileToken, selectedRole)
})

async function doSignIn(email, password) {
  if (!EMAIL_RE.test(email) || password.length < 8) {
    setStatus(statusEl, 'Enter a valid email and a password of at least 8 characters.', 'error')
    return
  }
  const restore = loading(submitBtn, 'Signing in…')
  setStatus(statusEl, '')
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    const role = data.user?.user_metadata?.role
    if (role === 'parent' || role === 'self') {
      try {
        await getFamily()
      } catch (famErr) {
        if (famErr.deactivated) {
          await supabase.auth.signOut()
          setStatus(statusEl, 'This account has been deactivated. Contact support if this was a mistake.', 'error')
          restore()
          return
        }
        throw famErr
      }
    }
    location.replace(role === 'parent' || role === 'self' ? DASHBOARD : CHILD)
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
    restore()
  }
}

async function doSignUp(email, password, turnstileToken, role) {
  const restore = loading(submitBtn, 'Creating…')
  setStatus(statusEl, '')
  try {
    // turnstile_token is captured for the record alongside the account;
    // server-side verification (calling Cloudflare's siteverify endpoint, as
    // send-confirmation does for the waitlist) is not wired up yet.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      // All new accounts start on the free plan; upgrades happen via Stripe later.
      options: { data: { role, plan: 'free', turnstile_token: turnstileToken } },
    })
    if (error) throw error
    if (data.session) {
      location.replace(DASHBOARD)
    } else {
      // Email confirmation required — hand off to the OTP verification page.
      sessionStorage.setItem('verify_email', email)
      location.replace(VERIFY)
    }
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
    restore()
    activateTurnstile() // token may be stale/used — force a fresh challenge before retrying
  }
}

googleBtn.addEventListener('click', async () => {
  const restore = loading(googleBtn, 'Redirecting…')
  setStatus(statusEl, '')
  try {
    // Lands back on the dashboard, whose own role check (see dashboard.js)
    // sends first-time Google users without a role yet to /app/select-role.html.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}${DASHBOARD}` },
    })
    if (error) throw error
    // On success the browser navigates away to Google immediately — no restore() needed.
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
    restore()
  }
})

function friendly(err) {
  const m = err?.message || 'Something went wrong.'
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password.'
  if (/already registered/i.test(m)) return 'That email already has an account — try signing in.'
  if (/email not confirmed/i.test(m)) return 'Please confirm your email before signing in — check your inbox for the confirmation link.'
  return m
}

// ============================================================================
// Account-less student entry. Entirely separate from #auth-form/applyMode —
// does not touch the sign in or create account flows at all. Visible on both
// the Sign in and Create account screens.
// ============================================================================
const studentToggle = $('#student-toggle')
const studentSection = $('#student-code-section')
const studentCodeInput = $('#student-code')
const studentStartBtn = $('#student-start-btn')
const studentStatusEl = $('[data-student-status]')

studentToggle.addEventListener('click', () => {
  const opening = studentSection.classList.contains('hidden')
  studentSection.classList.toggle('hidden', !opening)
  studentToggle.setAttribute('aria-expanded', String(opening))
  if (opening) studentCodeInput.focus()
})

studentCodeInput.addEventListener('input', () => {
  studentCodeInput.value = studentCodeInput.value.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()
})

studentCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    startStudying()
  }
})

studentStartBtn.addEventListener('click', startStudying)

async function startStudying() {
  const code = studentCodeInput.value
  if (code.length !== 6 || !supabaseAnon) {
    setStatus(studentStatusEl, 'Enter your 6-character code.', 'error')
    return
  }
  const restore = loading(studentStartBtn, 'Checking…')
  setStatus(studentStatusEl, '')
  try {
    const { data, error } = await supabaseAnon.rpc('redeem_child_code', { code })
    if (error) throw error
    const row = data?.[0]
    if (!row) throw new Error('Invalid or expired code')
    // Clear immediately so the code is no longer visible on screen.
    studentCodeInput.value = ''
    setChildSession({ child_id: row.child_id, child_name: row.child_name, family_id: row.family_id })
    location.href = STUDY
  } catch (err) {
    const msg = err?.message || ''
    setStatus(studentStatusEl, /invalid or expired/i.test(msg) ? 'Incorrect code. Try again.' : (msg || 'Could not verify code.'), 'error')
    studentCodeInput.value = ''
    studentCodeInput.focus()
    restore()
  }
}

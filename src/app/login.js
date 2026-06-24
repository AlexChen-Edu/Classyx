// Parent sign in / sign up + magic link.
import { supabase } from '../supabaseClient.js'
import { $, setStatus, loading } from './ui.js'

const DASHBOARD = '/app/dashboard.html'
const CHILD = '/app/child.html'

const form = $('#auth-form')
const emailEl = $('#email')
const passwordEl = $('#password')
const submitBtn = $('#submit')
const statusEl = $('[data-status]')
const magicBtn = $('#magic-link')

let mode = 'signin'

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

// Tab switching (Sign in / Create account)
document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode
    document.querySelectorAll('.auth-tab').forEach((t) =>
      t.setAttribute('aria-selected', String(t === tab)),
    )
    submitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Create account'
    passwordEl.autocomplete = mode === 'signin' ? 'current-password' : 'new-password'
    setStatus(statusEl, '')
  })
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = emailEl.value.trim()
  const password = passwordEl.value
  if (!email || password.length < 8) {
    setStatus(statusEl, 'Enter a valid email and a password of at least 8 characters.', 'error')
    return
  }
  const restore = loading(submitBtn, mode === 'signin' ? 'Signing in…' : 'Creating…')
  setStatus(statusEl, '')
  try {
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      location.replace(DASHBOARD)
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) throw error
      if (data.session) {
        location.replace(DASHBOARD)
      } else {
        setStatus(statusEl, 'Account created! Check your email to confirm, then sign in.', 'success')
        restore()
      }
    }
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
    restore()
  }
})

magicBtn.addEventListener('click', async () => {
  const email = emailEl.value.trim()
  if (!email) {
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

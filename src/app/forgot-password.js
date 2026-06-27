// Sends a password reset email. The link in that email lands on
// reset-password.html, which is where the actual password update happens.
import { supabase } from '../supabaseClient.js'
import { $, setStatus, loading } from './ui.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const form = $('#forgot-form')
const emailEl = $('#email')
const submitBtn = $('#submit')
const statusEl = $('[data-status]')

if (!supabase) {
  setStatus(statusEl, 'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.', 'error')
  form.querySelectorAll('input, button').forEach((el) => (el.disabled = true))
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = emailEl.value.trim()
  if (!EMAIL_RE.test(email)) {
    setStatus(statusEl, 'Enter a valid email address.', 'error')
    return
  }
  const restore = loading(submitBtn, 'Sending…')
  setStatus(statusEl, '')
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/app/reset-password.html`,
    })
    if (error) throw error
    setStatus(statusEl, 'Check your email for a password reset link.', 'success')
    form.querySelectorAll('input, button').forEach((el) => (el.disabled = true))
  } catch (err) {
    setStatus(statusEl, err.message || 'Could not send the reset link. Try again.', 'error')
    restore()
  }
})

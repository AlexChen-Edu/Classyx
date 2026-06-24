// Email verification via 6-digit OTP (replaces the old confirmation-link flow).
//
// NOTE: In Supabase dashboard go to Authentication → Email Templates and
// change the confirmation email template to use {{ .Token }} (the 6-digit
// code) instead of the confirmation link.
import { supabase } from '../supabaseClient.js'
import { $, $$, setStatus, loading } from './ui.js'

const LOGIN = '/app/login.html'
const DASHBOARD = '/app/dashboard.html'
const EMAIL_KEY = 'classyx.verifyEmail'

const form = $('#verify-form')
const subEl = $('#verify-sub')
const codeBoxes = $$('.pin-box')
const submitBtn = $('#submit')
const statusEl = $('[data-status]')
const resendLink = $('#resend-link')

const email = sessionStorage.getItem(EMAIL_KEY)

if (!supabase || !email) {
  // Nothing to verify without an email on hand — back to login.
  location.replace(LOGIN)
} else {
  subEl.textContent = `We sent a 6-digit code to ${email}. Enter it below.`
  codeBoxes[0].focus()
}

// --- Code boxes: digits only, auto-advance, auto-submit when full ----------
codeBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(0, 1)
    if (box.value && i < codeBoxes.length - 1) codeBoxes[i + 1].focus()
    if (codeBoxes.every((b) => b.value)) submitCode()
  })
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) codeBoxes[i - 1].focus()
  })
})

form.addEventListener('submit', (e) => {
  e.preventDefault()
  submitCode()
})

async function submitCode() {
  const code = codeBoxes.map((b) => b.value).join('')
  if (code.length !== 6) {
    setStatus(statusEl, 'Enter the full 6-digit code.', 'error')
    return
  }
  const restore = loading(submitBtn, 'Verifying…')
  setStatus(statusEl, '')
  try {
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'signup' })
    if (error) throw error
    sessionStorage.removeItem(EMAIL_KEY)
    location.replace(DASHBOARD)
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
    codeBoxes.forEach((b) => (b.value = ''))
    codeBoxes[0].focus()
    restore()
  }
}

resendLink.addEventListener('click', async (e) => {
  e.preventDefault()
  setStatus(statusEl, 'Sending a new code…')
  try {
    const { error } = await supabase.auth.resend({ email, type: 'signup' })
    if (error) throw error
    setStatus(statusEl, 'A new code is on its way — check your email.', 'success')
  } catch (err) {
    setStatus(statusEl, friendly(err), 'error')
  }
})

function friendly(err) {
  const m = err?.message || 'Something went wrong.'
  if (/token has expired|invalid/i.test(m)) return "That code is incorrect or has expired — try again or resend a new one."
  return m
}

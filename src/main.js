import { supabase } from './supabaseClient.js'

// Signal that the module loaded, so the inline reveal-fallback stays idle.
window.__classyxReady = true

/* --------------------------------------------------------------------------
 * Footer year
 * ------------------------------------------------------------------------ */
const yearEl = document.getElementById('year')
if (yearEl) yearEl.textContent = String(new Date().getFullYear())

/* --------------------------------------------------------------------------
 * Honor reduced-motion for every scripted motion below
 * ------------------------------------------------------------------------ */
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* --------------------------------------------------------------------------
 * Smooth in-page scrolling for anchor links
 * ------------------------------------------------------------------------ */
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (event) => {
    const targetId = link.getAttribute('href')
    if (!targetId || targetId === '#') return
    const target = document.querySelector(targetId)
    if (!target) return

    event.preventDefault()
    target.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    })
    // Move focus to the target for keyboard/screen-reader users.
    target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
  })
})

/* --------------------------------------------------------------------------
 * Sticky header elevation on scroll
 * ------------------------------------------------------------------------ */
const header = document.querySelector('[data-header]')
if (header) {
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8)
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
}

/* --------------------------------------------------------------------------
 * Reveal-on-scroll (progressive enhancement; disabled for reduced-motion)
 * ------------------------------------------------------------------------ */
const revealEls = document.querySelectorAll('[data-reveal]')
if (prefersReducedMotion || !('IntersectionObserver' in window)) {
  revealEls.forEach((el) => el.classList.add('is-visible'))
} else {
  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          obs.unobserve(entry.target)
        }
      })
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  )
  revealEls.forEach((el) => observer.observe(el))
}

/* --------------------------------------------------------------------------
 * Waitlist form
 * ------------------------------------------------------------------------ */
const form = document.getElementById('waitlist-form')

if (form) {
  const emailInput = document.getElementById('email')
  const statusEl = document.getElementById('form-status')
  const submitBtn = form.querySelector('[type="submit"]')
  const btnLabel = submitBtn.querySelector('[data-btn-label]') || submitBtn

  // Same shape the database enforces (CHECK constraint + RLS policy).
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  const setStatus = (state, message) => {
    statusEl.textContent = message
    statusEl.dataset.state = state // '' | 'success' | 'error'
  }

  let submitting = false

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submitting) return

    const email = emailInput.value.trim().toLowerCase()

    // 1) Client-side validation for instant feedback. The DB validates again
    //    (CHECK constraint + RLS WITH CHECK) — we never trust the client alone.
    if (!EMAIL_RE.test(email) || email.length > 254) {
      setStatus('error', 'Please enter a valid email address.')
      emailInput.focus()
      return
    }

    // 2) Guard: missing config shouldn't crash the page.
    if (!supabase) {
      setStatus('error', 'Sign-ups are temporarily unavailable. Please try again later.')
      return
    }

    submitting = true
    submitBtn.disabled = true
    const originalLabel = btnLabel.textContent
    btnLabel.textContent = 'Joining…'
    setStatus('', '')

    try {
      // No .select() on purpose: the anon role has INSERT only (no SELECT), and
      // we don't need the row returned. Chaining .select() would require read
      // access and would fail by design.
      const { error } = await supabase.from('waitlist').insert({ email })

      if (error) {
        // 23505 = unique violation (already on the list). We show the SAME
        // success message either way so we never reveal whether an email is
        // already registered (prevents email enumeration).
        if (error.code === '23505') {
          showSuccess()
        } else {
          // Never surface raw error objects / DB details to UI or console.
          setStatus('error', 'Something went wrong on our end. Please try again in a moment.')
        }
        return
      }

      showSuccess()
    } catch (_err) {
      // Network / unexpected failure — keep it generic, leak nothing.
      setStatus('error', 'We couldn’t reach the server. Check your connection and try again.')
    } finally {
      submitting = false
      submitBtn.disabled = false
      btnLabel.textContent = originalLabel
    }
  })

  function showSuccess() {
    setStatus('success', "You're on the list! We'll email you the moment Classyx opens.")
    form.reset()
  }
}
/* ── Waitlist Modal ── */
const modal = document.getElementById('waitlist-modal')
const openBtn = document.getElementById('open-modal-btn')
const closeBtn = modal.querySelector('.modal-close')
const consentBox = document.getElementById('modal-consent-checkbox')
const modalSubmit = document.getElementById('modal-submit')
const modalEmail = document.getElementById('modal-email')
const modalStatus = document.getElementById('modal-status')
const modalForm = document.getElementById('modal-form')

function openModal() {
  modal.removeAttribute('hidden')
  document.body.style.overflow = 'hidden'
  modalEmail.focus()
}

function closeModal() {
  modal.setAttribute('hidden', '')
  document.body.style.overflow = ''
  modalForm.reset()
  modalSubmit.disabled = true
  modalStatus.textContent = ''
  modalStatus.dataset.state = ''
}

openBtn.addEventListener('click', openModal)
document.querySelectorAll('.open-modal-btn, #open-modal-btn-nav').forEach(btn => {
  btn.addEventListener('click', openModal)
})
closeBtn.addEventListener('click', closeModal)
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal() })

consentBox.addEventListener('change', () => {
  modalSubmit.disabled = !consentBox.checked
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
let modalSubmitting = false

modalForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  if (modalSubmitting || !consentBox.checked) return

  const email = modalEmail.value.trim().toLowerCase()

  if (!EMAIL_RE.test(email) || email.length > 254) {
    modalStatus.textContent = 'Please enter a valid email address.'
    modalStatus.dataset.state = 'error'
    return
  }

  if (!supabase) {
    modalStatus.textContent = 'Sign-ups are temporarily unavailable. Please try again later.'
    modalStatus.dataset.state = 'error'
    return
  }

  modalSubmitting = true
  modalSubmit.disabled = true
  const label = modalSubmit.querySelector('[data-btn-label]') || modalSubmit
  const original = label.textContent
  label.textContent = 'Joining…'
  modalStatus.textContent = ''
  modalStatus.dataset.state = ''

  try {
    const res = await fetch('https://rohiuuqsdhnfzktlxlno.supabase.co/functions/v1/send-confirmation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
  email,
  turnstileToken: document.querySelector('.cf-turnstile input[name="cf-turnstile-response"]')?.value || ''
})
    })

    const data = await res.json()

    if (!res.ok) {
      if (res.status === 409) {
        showAlreadySignedUp()
      } else {
        modalStatus.textContent = 'Something went wrong. Please try again in a moment.'
        modalStatus.dataset.state = 'error'
      }
      return
    }
    showModalSuccess()
  } catch {
    modalStatus.textContent = "We couldn't reach the server. Check your connection and try again."
    modalStatus.dataset.state = 'error'
  } finally {
    modalSubmitting = false
    modalSubmit.disabled = !consentBox.checked
    label.textContent = original
  }
})

function showModalSuccess() {
  modalForm.style.display = 'none'
  const successHtml = `
    <div style="text-align:center;padding:20px 0">
      <div style="font-size:56px;margin-bottom:16px">📬</div>
      <h2 style="font-size:22px;font-weight:700;margin:0 0 12px">Check your email!</h2>
      <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px">We sent a confirmation link to your inbox. Click it to secure your spot on the Classyx waitlist.</p>
      <p style="color:#999;font-size:13px;margin:0">Didn't get it? Check your spam folder.</p>
    </div>
  `
  modalForm.insertAdjacentHTML('afterend', successHtml)
}
function showAlreadySignedUp() {
  modalForm.style.display = 'none'
  const html = `
    <div style="text-align:center;padding:20px 0">
      <div style="font-size:56px;margin-bottom:16px">👋</div>
      <h2 style="font-size:22px;font-weight:700;margin:0 0 12px">You're already on the list!</h2>
      <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px">We already have your email. You'll be one of the first to know when Classyx opens — we haven't forgotten about you.</p>
      <p style="color:#999;font-size:13px;margin:0">Keep an eye on your inbox. Good things are coming.</p>
    </div>
  `
  modalForm.insertAdjacentHTML('afterend', html)
}
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

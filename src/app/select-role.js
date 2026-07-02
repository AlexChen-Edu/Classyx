// Post-OAuth role pick. Google sign-in skips the email-signup role step
// entirely, so first-time Google users land here (redirected from
// dashboard.js when user_metadata.role is missing) to choose parent/self
// before continuing. Not reachable for the "student" role — kids never have
// their own account, so that choice only exists in the email-signup flow.
import { supabase } from '../supabaseClient.js'
import { requireSession, getFamily } from './auth.js'
import { $, $$, setStatus, loading, friendlyMessage } from './ui.js'

const DASHBOARD = '/app/dashboard.html'

const roleCards = $$('.role-card')
const statusEl = $('#select-role-status')

async function main() {
  const session = await requireSession()
  if (!session) return
  const role = session.user.user_metadata?.role
  if (role) {
    location.replace(DASHBOARD)
    return
  }
  roleCards.forEach((card) => card.addEventListener('click', () => chooseRole(card)))
}

async function chooseRole(card) {
  const role = card.dataset.role
  roleCards.forEach((c) => (c.disabled = true))
  card.classList.add('is-selected')
  setStatus(statusEl, '')
  const restore = loading(card, 'Saving…')
  try {
    const { error } = await supabase.auth.updateUser({ data: { role, plan: 'free' } })
    if (error) throw error
    if (role === 'parent' || role === 'self') {
      try {
        await getFamily()
      } catch (famErr) {
        if (famErr.deactivated) {
          await supabase.auth.signOut()
          setStatus(statusEl, 'This account has been deactivated. Contact support if this was a mistake.', 'error')
          restore()
          roleCards.forEach((c) => (c.disabled = false))
          return
        }
        throw famErr
      }
    }
    location.replace(DASHBOARD)
  } catch (err) {
    setStatus(statusEl, friendlyMessage(err, 'Could not save your choice. Try again.'), 'error')
    restore()
    roleCards.forEach((c) => (c.disabled = false))
    card.classList.remove('is-selected')
  }
}

main()

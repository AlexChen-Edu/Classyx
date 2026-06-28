// Session, family bootstrap, and the active-child selection store.
// The parent's Supabase session is the only auth principal; the active child is
// just a UI selection (gated by a PIN on the child page), kept in sessionStorage.

import { supabase } from '../supabaseClient.js'

export const LOGIN_URL = '/app/login.html'

/** Redirect to login if there's no client or no session. Returns the session. */
export async function requireSession() {
  if (!supabase) {
    location.replace(LOGIN_URL)
    return null
  }
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    location.replace(LOGIN_URL)
    return null
  }
  return session
}

let _family = null

/** Get the current user's family, creating it on first login. Cached per page. */
export async function getFamily() {
  if (_family) return _family
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const { data: existing, error } = await supabase
    .from('families')
    .select('id, plan')
    .eq('parent_id', user.id)
    .maybeSingle()
  if (error) throw error

  if (existing) {
    _family = existing
    return _family
  }

  const { data: created, error: insErr } = await supabase
    .from('families')
    .insert({ parent_id: user.id, plan: 'student' })
    .select('id, plan')
    .single()
  if (insErr) throw insErr
  _family = created
  return _family
}

export async function signOut() {
  clearActiveChild()
  clearChildSession()
  if (supabase) await supabase.auth.signOut()
  location.replace(LOGIN_URL)
}

// --- Active child (UI selection only) --------------------------------------
const ACTIVE_KEY = 'classyx.activeChild'

export function setActiveChild(child) {
  sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({
    id: child.id, name: child.name, grade: child.grade,
    daily_goal_minutes: child.daily_goal_minutes ?? 30,
  }))
}

export function getActiveChild() {
  try {
    return JSON.parse(sessionStorage.getItem(ACTIVE_KEY) || 'null')
  } catch {
    return null
  }
}

export function clearActiveChild() {
  sessionStorage.removeItem(ACTIVE_KEY)
}

// --- Account-less child session (redeem_child_code result) -----------------
// Unlike getActiveChild() above (a UI cache for an authenticated parent's own
// picker — actual access is still enforced server-side by RLS on every
// request), this IS the proof of identity for an account-less child: there
// is no parent session to fall back on, so study.js trusts this value
// directly once it's been set by a successful redeem_child_code call.
const CHILD_SESSION_KEY = 'classyx.childSession'

export function setChildSession({ child_id, child_name, family_id, daily_goal_minutes }) {
  sessionStorage.setItem(CHILD_SESSION_KEY, JSON.stringify({
    child_id, child_name, family_id, daily_goal_minutes: daily_goal_minutes ?? 30,
  }))
}

export function getChildSession() {
  try {
    return JSON.parse(sessionStorage.getItem(CHILD_SESSION_KEY) || 'null')
  } catch {
    return null
  }
}

export function clearChildSession() {
  sessionStorage.removeItem(CHILD_SESSION_KEY)
}

// --- Remembered device (account-less "stay signed in" on this browser) ----
// Unlike CHILD_SESSION_KEY above (sessionStorage — gone when the tab closes),
// this persists in localStorage across tab/browser restarts so a kid doesn't
// have to re-enter their code every time. It's still just a UI convenience,
// not a security boundary: it only ever holds the same child_id/name/family_id
// that redeem_child_code already returned, and every actual data request is
// still enforced server-side by RLS. No expiry by design — it lasts until the
// "Forget this device" / "Switch profile" actions clear it.
const REMEMBERED_DEVICE_KEY = 'classyx_child_profile'

export function setRememberedDevice({ child_id, child_name, family_id, daily_goal_minutes }) {
  localStorage.setItem(REMEMBERED_DEVICE_KEY, JSON.stringify({
    child_id, child_name, family_id, daily_goal_minutes: daily_goal_minutes ?? 30,
    saved_at: new Date().toISOString(),
  }))
}

export function getRememberedDevice() {
  try {
    return JSON.parse(localStorage.getItem(REMEMBERED_DEVICE_KEY) || 'null')
  } catch {
    return null
  }
}

export function clearRememberedDevice() {
  localStorage.removeItem(REMEMBERED_DEVICE_KEY)
}

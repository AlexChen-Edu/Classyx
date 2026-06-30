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
    .select('id, plan, is_deactivated')
    .eq('parent_id', user.id)
    .maybeSingle()
  if (error) throw error

  if (existing) {
    if (existing.is_deactivated) {
      const e = new Error('This account has been deactivated.')
      e.deactivated = true
      throw e
    }
    _family = existing
    return _family
  }

  const { data: created, error: insErr } = await supabase
    .from('families')
    .insert({ parent_id: user.id, plan: 'student' })
    .select('id, plan, is_deactivated')
    .single()
  if (insErr) throw insErr
  _family = created
  return _family
}

let _selfChild = null

/**
 * For role='self' accounts: the one children row that represents the account
 * holder themselves, auto-created on first access so a self learner can reuse
 * all the child-scoped study/analytics infrastructure without a PIN/code —
 * there's no second person to gate, the parent-authenticated session already
 * IS their proof of identity. A self family only ever has this one child row.
 * Cached per page, same pattern as getFamily().
 */
export async function getSelfChild() {
  if (_selfChild) return _selfChild
  const family = await getFamily()

  const { data: existing, error } = await supabase
    .from('children')
    .select('id, name, grade, daily_goal_minutes, created_at')
    .eq('family_id', family.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (existing) {
    _selfChild = existing
    return _selfChild
  }

  const { data: { user } } = await supabase.auth.getUser()
  const local = user?.email ? user.email.split('@')[0] : 'Me'
  const name = local.charAt(0).toUpperCase() + local.slice(1)

  const { data: created, error: insErr } = await supabase
    .from('children')
    .insert({ family_id: family.id, name })
    .select('id, name, grade, daily_goal_minutes, created_at')
    .single()
  if (insErr) throw insErr
  _selfChild = created
  return _selfChild
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

// --- Last-studied tracking (device-local, for the streak-at-risk nudge) ----
// A lightweight on-device record of which calendar day each child last
// finished a study session, keyed by child_id. This exists because the
// welcome-back screen runs for account-less children, who have no RLS
// access to study_sessions at all (see getChildStreak's comment in api.js)
// — so the "studied today / studied yesterday" check has to come from
// something other than a DB query.
const LAST_STUDIED_KEY = 'classyx_last_studied'

function readLastStudiedMap() {
  try {
    return JSON.parse(localStorage.getItem(LAST_STUDIED_KEY) || '{}')
  } catch {
    return {}
  }
}

export function markStudiedToday(childId) {
  const map = readLastStudiedMap()
  map[childId] = new Date().toDateString()
  localStorage.setItem(LAST_STUDIED_KEY, JSON.stringify(map))
}

/** Returns whether childId's most recent recorded session was today / yesterday. */
export function getStudyRecency(childId) {
  const last = readLastStudiedMap()[childId]
  if (!last) return { today: false, yesterday: false }
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return { today: last === new Date().toDateString(), yesterday: last === yesterday.toDateString() }
}

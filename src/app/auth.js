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
  if (supabase) await supabase.auth.signOut()
  location.replace(LOGIN_URL)
}

// --- Active child (UI selection only) --------------------------------------
const ACTIVE_KEY = 'classyx.activeChild'

export function setActiveChild(child) {
  sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({ id: child.id, name: child.name, grade: child.grade }))
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

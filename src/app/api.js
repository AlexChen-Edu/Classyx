// Data layer: every call runs under the parent's session, so RLS scopes results
// to their family automatically. We never select '*' on children (pin_hash is
// revoked) — only explicit, safe columns.

import { supabase, supabaseAnon } from '../supabaseClient.js'
import { getFamily } from './auth.js'

const CHILD_COLS = 'id, name, grade, created_at'

// --- Children ---------------------------------------------------------------

/** Max child profiles per plan. Missing/unrecognized plan -> treated as free. */
export const PLAN_CHILD_LIMITS = { free: 1, single_child: 1, family: 3 }

export function childLimitFor(plan) {
  return PLAN_CHILD_LIMITS[plan] ?? PLAN_CHILD_LIMITS.free
}

export async function listChildren() {
  const { data, error } = await supabase
    .from('children')
    .select(CHILD_COLS)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function createChild({ name, grade }) {
  const family = await getFamily()
  const { data, error } = await supabase
    .from('children')
    .insert({ family_id: family.id, name: name.trim(), grade: grade?.trim() || null })
    .select(CHILD_COLS)
    .single()
  if (error) throw error
  return data
}

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Generate a 6-character lowercase-alphanumeric code using crypto.getRandomValues()
 * (not Math.random()) so it's drawn from a cryptographically secure source.
 */
export function generateChildCode() {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

/** Set a child's access code via the SECURITY DEFINER function (hashes server-side). */
export async function setChildPin(childId, code) {
  const { error } = await supabase.rpc('set_child_pin', { child: childId, new_pin: code })
  if (error) throw error
}

/** Returns true if the code is correct OR no code is set (open profile). */
export async function verifyChildPin(childId, code) {
  const { data, error } = await supabase.rpc('verify_child_pin', { child: childId, attempt: code })
  if (error) throw error
  return data === true
}

/**
 * Generates and stores a brand-new code for a child, returning it in plain
 * text — the only moment it's ever visible, since pin_hash can't be reversed.
 * Calling this again (e.g. "Refresh code") invalidates whatever code was
 * shown before, by design (see the get_child_code migration).
 */
export async function refreshChildCode(childId) {
  const { data, error } = await supabase.rpc('get_child_code', { p_child_id: childId })
  if (error) throw error
  return data
}

// --- Uploads + AI generation ------------------------------------------------

/** Upload a file to the private bucket and create an uploads row. */
export async function uploadNote({ child, file, subject }) {
  const family = await getFamily()
  const ext = (file.name.split('.').pop() || 'dat').toLowerCase()
  const path = `${family.id}/${child.id}/${crypto.randomUUID()}.${ext}`

  const { error: upErr } = await supabase.storage
    .from('uploads')
    .upload(path, file, { contentType: file.type || undefined, upsert: false })
  if (upErr) throw upErr

  const { data, error } = await supabase
    .from('uploads')
    .insert({ child_id: child.id, file_path: path, subject: subject || null })
    .select('id, subject')
    .single()
  if (error) throw error
  return data
}

/**
 * Invoke the generate-content Edge Function. Surfaces a friendly message,
 * including the "AI not configured yet" (503) state before the key is set.
 */
export async function generateContent({ uploadId, childId, subject }) {
  const { data, error } = await supabase.functions.invoke('generate-content', {
    body: { upload_id: uploadId, child_id: childId, subject },
  })
  if (error) {
    let message = 'Generation failed. Please try again.'
    let notConfigured = false
    try {
      const body = await error.context?.json?.()
      if (body?.message) message = body.message
      if (body?.error === 'not_configured') notConfigured = true
    } catch { /* keep default */ }
    const e = new Error(message)
    e.notConfigured = notConfigured
    throw e
  }
  return data
}

export async function getFlashcards(uploadId) {
  const { data, error } = await supabase
    .from('flashcards')
    .select('id, question, answer')
    .eq('upload_id', uploadId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function getStudyGuide(uploadId) {
  const { data, error } = await supabase
    .from('study_guides')
    .select('id, content, subject')
    .eq('upload_id', uploadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  let guide = { summary: '', key_concepts: [], practice_questions: [] }
  try { guide = { ...guide, ...JSON.parse(data.content) } } catch { /* leave default */ }
  return { ...data, guide }
}

// --- Self-test --------------------------------------------------------------

export async function recordQuizResult({ childId, flashcardId, correct }) {
  const { error } = await supabase
    .from('quiz_results')
    .insert({ child_id: childId, flashcard_id: flashcardId, correct })
  if (error) throw error
}

// --- Study sessions (timer) -------------------------------------------------

export async function startSession({ childId, subject }) {
  const { data, error } = await supabase
    .from('study_sessions')
    .insert({ child_id: childId, subject: subject || null })
    .select('id, started_at')
    .single()
  if (error) throw error
  return data
}

/** Update an open session's end time + duration. Best-effort (errors ignored). */
export async function touchSession({ sessionId, startedAtMs, pausedMs = 0 }) {
  const minutes = Math.max(0, Math.round((Date.now() - startedAtMs - pausedMs) / 60000))
  await supabase
    .from('study_sessions')
    .update({ ended_at: new Date().toISOString(), duration_minutes: minutes })
    .eq('id', sessionId)
}

/**
 * Account-less child path: anon has no direct RLS access to study_sessions
 * (see the save_child_session migration), so this calls the SECURITY
 * DEFINER RPC instead. Requires a live active_sessions row for childId —
 * call this before endPresence()/endPresenceBeacon() tears that row down.
 */
export async function saveChildSession({ childId, subject, durationMinutes }) {
  if (!supabaseAnon) return
  const { error } = await supabaseAnon.rpc('save_child_session', {
    p_child_id: childId,
    p_subject: subject || null,
    p_duration_minutes: durationMinutes,
  })
  if (error) throw error
}

/**
 * Best-effort beacon variant for pagehide/beforeunload, same rationale as
 * endPresenceBeacon — a normal awaited call can't be trusted to complete
 * before the page is torn down.
 */
export function saveChildSessionBeacon({ childId, subject, durationMinutes }) {
  try {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/save_child_session`
    fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ p_child_id: childId, p_subject: subject || null, p_duration_minutes: durationMinutes }),
    }).catch(() => {})
  } catch { /* best effort */ }
}

// --- Live presence (active_sessions) ----------------------------------------
// Always written via supabaseAnon: the anon insert/update policies on this
// table are intentionally unscoped (a student using a parent-generated code
// has no Supabase Auth identity to scope a policy to — see the migration),
// so there's no need to branch on whether the caller is actually a signed-in
// parent. Only the SELECT side (getActiveSessions, used by the dashboard) is
// ownership-scoped, via the regular authenticated `supabase` client.

/**
 * Plain INSERT, falling back to UPDATE on a unique-violation (child_id
 * already has a row from an earlier session). Deliberately not `.upsert()`:
 * under RLS, INSERT...ON CONFLICT DO UPDATE must satisfy both the INSERT and
 * UPDATE policies simultaneously for the conflict branch, which fails here
 * even though each policy independently allows the plain operation — this
 * two-step approach avoids that interaction entirely (verified live).
 */
export async function startPresence(childId) {
  if (!supabaseAnon) return
  const now = new Date().toISOString()
  const { error } = await supabaseAnon
    .from('active_sessions')
    .insert({ child_id: childId, started_at: now, last_ping: now, paused_ms: 0 })
  if (error?.code === '23505') {
    await supabaseAnon
      .from('active_sessions')
      .update({ started_at: now, last_ping: now, paused_ms: 0 })
      .eq('child_id', childId)
  }
}

/** pausedMs is the session's cumulative paused time so far, in milliseconds. */
export async function pingPresence(childId, pausedMs = 0) {
  if (!supabaseAnon) return
  await supabaseAnon
    .from('active_sessions')
    .update({ last_ping: new Date().toISOString(), paused_ms: pausedMs })
    .eq('child_id', childId)
}

/**
 * Best-effort presence cleanup on tab close/navigation, called from a
 * pagehide/beforeunload listener. Posts to the end_active_session RPC
 * (the table itself has no anon DELETE policy/grant — see the migration).
 *
 * navigator.sendBeacon was tried first and verified NOT to work reliably
 * here: a Blob with Content-Type: application/json is a non-"simple" CORS
 * content-type, which requires a preflight that sendBeacon doesn't reliably
 * wait for — the browser reports success (sendBeacon returns true) but the
 * request never actually reaches the server (confirmed live: the row was
 * never deleted). `fetch` with `keepalive: true` is the modern replacement
 * for exactly this "survive page unload" use case and handles the preflight
 * correctly; verified live that the row IS deleted with this approach.
 */
export function endPresenceBeacon(childId) {
  try {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/end_active_session`
    fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ p_child_id: childId }),
    }).catch(() => {})
  } catch { /* best effort */ }
}

/** RLS-scoped to the caller's own children; used by the parent dashboard. */
export async function getActiveSessions() {
  const { data, error } = await supabase
    .from('active_sessions')
    .select('child_id, started_at, last_ping, paused_ms')
  if (error) throw error
  return data ?? []
}

/**
 * A single child's own active_sessions row — polled by study.js so its timer
 * reads the exact same data the parent dashboard reads, instead of keeping
 * an independent client-side clock that can drift out of sync. Via the
 * authenticated client (parent-picked profile path); owns_child(child_id)
 * is satisfied since this is always the caller's own child.
 */
export async function getOwnActiveSession(childId) {
  const { data, error } = await supabase
    .from('active_sessions')
    .select('started_at, paused_ms')
    .eq('child_id', childId)
    .maybeSingle()
  if (error) throw error
  return data
}

/** Same, via the anon client — the account-less child path. */
export async function getOwnActiveSessionAnon(childId) {
  if (!supabaseAnon) return null
  const { data, error } = await supabaseAnon
    .from('active_sessions')
    .select('started_at, paused_ms')
    .eq('child_id', childId)
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * Just the session dates needed for a streak calc — used by study.js, which
 * may be running as an account-less child (no parent JWT). Under RLS that
 * has no SELECT access to study_sessions at all, so this throws for that
 * case; callers should treat a thrown error the same as "no streak yet".
 */
export async function getChildStreak(childId) {
  const { data, error } = await supabase
    .from('study_sessions')
    .select('started_at')
    .eq('child_id', childId)
  if (error) throw error
  return data ?? []
}

// --- Per-child analytics (app/analytics.html) -------------------------------
// One bulk, unfiltered-by-period fetch per child; analytics.js slices this
// same dataset client-side for "This Week" vs "This Month" so switching tabs
// never re-queries. RLS (owns_child / owns_family) scopes every query to the
// caller's own family — a child_id from another family simply returns no
// rows / null, never an error that would leak its existence.
export async function getChildAnalytics(childId) {
  const [{ data: child, error: childErr }, { data: sessions, error: sessErr }, { data: quizzes, error: quizErr }] =
    await Promise.all([
      supabase.from('children').select('id, name, grade').eq('id', childId).maybeSingle(),
      supabase
        .from('study_sessions')
        .select('started_at, duration_minutes, subject')
        .eq('child_id', childId)
        .order('started_at', { ascending: true }),
      supabase
        .from('quiz_results')
        .select('correct, answered_at')
        .eq('child_id', childId)
        .order('answered_at', { ascending: true }),
    ])
  if (childErr) throw childErr
  if (sessErr) throw sessErr
  if (quizErr) throw quizErr
  if (!child) throw new Error('Child not found')
  return { child, sessions: sessions ?? [], quizzes: quizzes ?? [] }
}

// --- Dashboard aggregates ---------------------------------------------------

export async function getDashboardData() {
  const children = await listChildren()
  const [{ data: sessions }, { data: quizzes }] = await Promise.all([
    supabase.from('study_sessions').select('child_id, started_at, duration_minutes'),
    supabase.from('quiz_results').select('child_id, correct, answered_at'),
  ])

  // Start of the current week (Monday 00:00 local).
  const now = new Date()
  const day = (now.getDay() + 6) % 7
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day)

  return children.map((child) => {
    const cSessions = (sessions ?? []).filter((s) => s.child_id === child.id)
    const cQuizzes = (quizzes ?? []).filter((q) => q.child_id === child.id)

    const weekMinutes = cSessions
      .filter((s) => new Date(s.started_at) >= weekStart)
      .reduce((sum, s) => sum + (s.duration_minutes || 0), 0)

    const lastStudied = cSessions
      .map((s) => s.started_at)
      .sort()
      .at(-1) || null

    const total = cQuizzes.length
    const correct = cQuizzes.filter((q) => q.correct).length
    const accuracy = total ? Math.round((correct / total) * 100) : null

    return { ...child, weekMinutes, lastStudied, quizCount: total, accuracy }
  })
}

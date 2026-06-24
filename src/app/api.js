// Data layer: every call runs under the parent's session, so RLS scopes results
// to their family automatically. We never select '*' on children (pin_hash is
// revoked) — only explicit, safe columns.

import { supabase } from '../supabaseClient.js'
import { getFamily } from './auth.js'

const CHILD_COLS = 'id, name, grade, created_at'

// --- Children ---------------------------------------------------------------

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

/** Set a child's PIN via the SECURITY DEFINER function (hashes server-side). */
export async function setChildPin(childId, pin) {
  const { error } = await supabase.rpc('set_child_pin', { child: childId, new_pin: pin })
  if (error) throw error
}

/** Returns true if the PIN is correct OR no PIN is set (open profile). */
export async function verifyChildPin(childId, pin) {
  const { data, error } = await supabase.rpc('verify_child_pin', { child: childId, attempt: pin })
  if (error) throw error
  return data === true
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
export async function touchSession({ sessionId, startedAtMs }) {
  const minutes = Math.max(0, Math.round((Date.now() - startedAtMs) / 60000))
  await supabase
    .from('study_sessions')
    .update({ ended_at: new Date().toISOString(), duration_minutes: minutes })
    .eq('id', sessionId)
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

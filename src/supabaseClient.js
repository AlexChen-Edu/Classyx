import { createClient } from '@supabase/supabase-js'

/**
 * Public, client-side Supabase config.
 *
 * Values are injected at build time from environment variables (see
 * .env.example) — they are never hard-coded in source. The anon key is PUBLIC
 * by design: it ships in the browser bundle and that is expected. Security is
 * enforced server-side by Row Level Security (the anon role may only INSERT
 * into `waitlist`; it cannot read, update, or delete).
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // Generic, schema-free notice to help during setup. Leaks nothing sensitive.
  console.warn(
    '[Classyx] Supabase environment variables are missing. ' +
      'Copy .env.example to .env and add your project URL + anon key.'
  )
}

export const supabase =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null

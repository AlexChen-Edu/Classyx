# ===========================================================================
# Push server-side secrets to Supabase (production Edge Functions).
# ---------------------------------------------------------------------------
# This is a TEMPLATE. Do NOT commit a copy with a real key.
#   1. Fill in the placeholder(s) below.
#   2. Run it once:   powershell -File scripts/set-supabase-secrets.example.ps1
#
# Requires the Supabase CLI, logged in and linked to the project:
#   supabase login
#   supabase link --project-ref rohiuuqsdhnfzktlxlno
#
# These secrets are read by the generate-content Edge Function via
# Deno.env.get(...). They are NEVER exposed to the browser.
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform
# automatically — do not set them here.
# ===========================================================================

# >>> PASTE YOUR OPENAI KEY HERE WHEN READY <<<
$OPENAI_API_KEY = "sk-REPLACE_WITH_YOUR_OPENAI_KEY"

if ($OPENAI_API_KEY -like "sk-REPLACE_*") {
    Write-Error "Edit this file and set a real OPENAI_API_KEY before running."
    exit 1
}

supabase secrets set OPENAI_API_KEY=$OPENAI_API_KEY

# Optional model override:
# supabase secrets set OPENAI_MODEL=gpt-4o-mini

Write-Host "Done. Verify with:  supabase secrets list"

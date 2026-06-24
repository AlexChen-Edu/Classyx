// ===========================================================================
// generate-content — Classyx AI generation (server-side ONLY)
// ---------------------------------------------------------------------------
// Input  (POST JSON):  { upload_id, child_id, subject }
// Output (JSON):       { success: true, flashcard_count, guide_id }
//
// Flow:
//   1. Verify the caller's JWT and that they OWN the upload/child (RLS-scoped
//      client). The service-role key is only used AFTER ownership is proven.
//   2. Download the uploaded note (image or PDF) from the private "uploads"
//      bucket with the service-role client.
//   3. Send it to OpenAI (gpt-4o-mini, multimodal — handles image OCR and PDF
//      reading in a single call) and ask for 20 flashcards + a structured
//      study guide as strict JSON.
//   4. Persist flashcards + study_guide, mark the upload processed.
//
// SECURITY:
//   * OPENAI_API_KEY lives ONLY here (Deno.env), never in the browser.
//   * Until OPENAI_API_KEY is set, this returns HTTP 503 "not configured" so
//     the rest of the app keeps working — drop the key in later, no code change.
//   * SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
//     automatically by the platform.
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

// The OpenAI key is intentionally a placeholder until the user sets it.
function getOpenAiKey(): string | null {
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!key || key.startsWith("sk-REPLACE")) return null; // not configured yet
  return key;
}

// Map a file extension to how OpenAI should receive it.
function classify(path: string): { kind: "image" | "pdf"; mime: string } | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const images: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
  };
  if (ext in images) return { kind: "image", mime: images[ext] };
  if (ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
  return null;
}

// Base64-encode bytes in chunks (avoids call-stack overflow on large files).
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const SYSTEM_PROMPT =
  "You are a study assistant for K-12 and early-college students. You read a " +
  "student's uploaded class notes (an image or PDF) and turn them into study " +
  "materials. Be accurate to the source notes; do not invent facts that are " +
  "not supported by the notes. Keep questions and answers concise and clear " +
  "for the student's level.";

// Strict JSON schema for the model's output.
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    flashcards: {
      type: "array",
      description: "About 20 question/answer flashcards drawn from the notes.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
        required: ["question", "answer"],
      },
    },
    study_guide: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        key_concepts: { type: "array", items: { type: "string" } },
        practice_questions: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "key_concepts", "practice_questions"],
    },
  },
  required: ["flashcards", "study_guide"],
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // --- Parse input ---------------------------------------------------------
  let upload_id: string, child_id: string, subject: string | undefined;
  try {
    const body = await req.json();
    upload_id = body.upload_id;
    child_id = body.child_id;
    subject = body.subject;
    if (!upload_id || !child_id) throw new Error("missing fields");
  } catch {
    return json({ error: "upload_id and child_id are required" }, 400);
  }

  // --- Authn/authz: prove the caller owns this upload (RLS-scoped client) ---
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Not authenticated" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: upload, error: ownErr } = await userClient
    .from("uploads")
    .select("id, child_id, file_path, subject")
    .eq("id", upload_id)
    .maybeSingle();

  if (ownErr) return json({ error: "Authorization check failed" }, 500);
  if (!upload || upload.child_id !== child_id) {
    // Either it doesn't exist or RLS hid it because they don't own it.
    return json({ error: "Upload not found" }, 404);
  }

  // --- AI key gate: graceful "not configured" until the key is set ----------
  const openAiKey = getOpenAiKey();
  if (!openAiKey) {
    return json(
      {
        error: "not_configured",
        message:
          "AI generation isn't set up yet. An admin needs to add the OpenAI " +
          "API key (supabase secrets set OPENAI_API_KEY=...).",
      },
      503,
    );
  }

  // From here on we use the service-role client (ownership already proven).
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // --- Download the note from private storage ----------------------------
    const { data: blob, error: dlErr } = await admin.storage
      .from("uploads")
      .download(upload.file_path);
    if (dlErr || !blob) throw new Error(`Could not read uploaded file: ${dlErr?.message}`);

    const meta = classify(upload.file_path);
    if (!meta) throw new Error("Unsupported file type (use an image or PDF).");

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dataUrl = `data:${meta.mime};base64,${toBase64(bytes)}`;
    const subj = subject || upload.subject || "these notes";

    // --- Build the multimodal request --------------------------------------
    const userContent: unknown[] = [
      {
        type: "input_text",
        text:
          `These are a student's notes for ${subj}. Read them carefully and ` +
          `produce exactly 20 flashcards (question/answer) plus a study guide ` +
          `with a short summary, a list of key concepts, and 5 practice ` +
          `questions. Base everything strictly on the notes.`,
      },
      meta.kind === "image"
        ? { type: "input_image", image_url: dataUrl }
        : {
            type: "input_file",
            filename: upload.file_path.split("/").pop() ?? "notes.pdf",
            file_data: dataUrl,
          },
    ];

    // --- Call OpenAI (Responses API: supports both images and PDFs) --------
    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          { role: "user", content: userContent },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "study_pack",
            strict: true,
            schema: OUTPUT_SCHEMA,
          },
        },
      }),
    });

    if (!aiRes.ok) {
      const detail = await aiRes.text();
      console.error("OpenAI error:", aiRes.status, detail);
      throw new Error(`AI request failed (${aiRes.status}).`);
    }

    const ai = await aiRes.json();

    // Extract the JSON text from the Responses API payload.
    let outText: string | undefined = ai.output_text;
    if (!outText && Array.isArray(ai.output)) {
      for (const item of ai.output) {
        const part = item?.content?.find?.((c: { type: string }) => c.type === "output_text");
        if (part?.text) { outText = part.text; break; }
      }
    }
    if (!outText) throw new Error("AI returned no usable content.");

    let parsed: {
      flashcards: { question: string; answer: string }[];
      study_guide: { summary: string; key_concepts: string[]; practice_questions: string[] };
    };
    try {
      parsed = JSON.parse(outText);
    } catch {
      throw new Error("AI returned malformed JSON.");
    }

    const flashcards = (parsed.flashcards ?? []).filter((f) => f.question && f.answer);
    if (flashcards.length === 0) throw new Error("No flashcards were generated.");

    // --- Persist results ---------------------------------------------------
    const { error: fcErr } = await admin.from("flashcards").insert(
      flashcards.map((f) => ({
        upload_id,
        child_id,
        question: f.question,
        answer: f.answer,
      })),
    );
    if (fcErr) throw new Error(`Saving flashcards failed: ${fcErr.message}`);

    const { data: guide, error: sgErr } = await admin
      .from("study_guides")
      .insert({
        upload_id,
        child_id,
        subject: subj,
        content: JSON.stringify(parsed.study_guide ?? {}),
      })
      .select("id")
      .single();
    if (sgErr) throw new Error(`Saving study guide failed: ${sgErr.message}`);

    await admin
      .from("uploads")
      .update({ processed: true, error: null })
      .eq("id", upload_id);

    return json({
      success: true,
      flashcard_count: flashcards.length,
      guide_id: guide.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed.";
    console.error("generate-content failed:", message);
    // Record the failure on the upload so the UI can show a retry/error state.
    await admin.from("uploads").update({ processed: false, error: message }).eq("id", upload_id);
    return json({ error: "generation_failed", message }, 500);
  }
});

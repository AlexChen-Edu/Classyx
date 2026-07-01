// ===========================================================================
// generate-content — Classyx AI generation (server-side ONLY)
// ---------------------------------------------------------------------------
// Modes:
//   flashcards  — 20 Q&A flashcards + study guide, saved to DB
//   solve       — Socratic guidance on a problem, returned directly
//   summarize   — concise summary + key points, returned directly
//   ask         — text question answered without a file upload
//
// Input (POST JSON):
//   { mode, child_id, upload_id?, subject? }  — for flashcards/solve/summarize
//   { mode: 'ask', child_id, question }        — for ask
//
// SECURITY:
//   * OPENAI_API_KEY lives ONLY here (Deno.env), never in the browser.
//   * Until OPENAI_API_KEY is set, returns HTTP 503 "not configured".
//   * SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
//     injected automatically by the platform.
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

const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5.4-nano";

function getOpenAiKey(): string | null {
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!key || key.startsWith("sk-REPLACE")) return null;
  return key;
}

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

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extractOutputText(ai: unknown): string | undefined {
  const a = ai as Record<string, unknown>;
  if (typeof a.output_text === "string") return a.output_text;
  if (Array.isArray(a.output)) {
    for (const item of a.output) {
      const parts = (item as Record<string, unknown>)?.content;
      if (Array.isArray(parts)) {
        const t = parts.find((c: { type: string }) => c.type === "output_text");
        if (t && typeof (t as Record<string, unknown>).text === "string") {
          return (t as Record<string, string>).text;
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-mode system prompts
// ---------------------------------------------------------------------------
const SYSTEM_PROMPTS: Record<string, string> = {
  flashcards:
    "You are a study assistant for K-12 and early-college students. You read a " +
    "student's uploaded class notes (an image or PDF) and turn them into study " +
    "materials. Be accurate to the source notes; do not invent facts that are " +
    "not supported by the notes. Keep questions and answers concise and clear " +
    "for the student's level.",
  solve:
    "You are a Socratic tutor. Do NOT give the answer directly. Instead, look at " +
    "the problem and guide the student to figure it out themselves. Ask a leading " +
    "question, explain the concept behind it, and show the first step only. " +
    "Return JSON with { concept: string, hint: string, first_step: string, guiding_question: string }",
  summarize:
    "Summarize the key concepts from these notes into a clear, concise study guide. " +
    "Return JSON with { summary: string, key_points: string[] }",
  ask:
    "You are a friendly, clear tutor for students. Answer this question in a way " +
    "that's easy to understand. Use simple language. Return JSON with " +
    "{ answer: string, key_points: string[], follow_up_questions: string[] } " +
    "where follow_up_questions are 2-3 related questions the student might want to explore next.",
};

// ---------------------------------------------------------------------------
// Per-mode JSON output schemas (strict mode for OpenAI structured output)
// ---------------------------------------------------------------------------
const OUTPUT_SCHEMAS: Record<string, object> = {
  flashcards: {
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
  },
  solve: {
    type: "object",
    additionalProperties: false,
    properties: {
      concept: { type: "string" },
      hint: { type: "string" },
      first_step: { type: "string" },
      guiding_question: { type: "string" },
    },
    required: ["concept", "hint", "first_step", "guiding_question"],
  },
  summarize: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      key_points: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "key_points"],
  },
  ask: {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: { type: "string" },
      key_points: { type: "array", items: { type: "string" } },
      follow_up_questions: { type: "array", items: { type: "string" } },
    },
    required: ["answer", "key_points", "follow_up_questions"],
  },
};

const SCHEMA_NAMES: Record<string, string> = {
  flashcards: "study_pack",
  solve: "solve_response",
  summarize: "summarize_response",
  ask: "ask_response",
};

async function callOpenAI(
  openAiKey: string,
  mode: string,
  userContent: unknown[],
): Promise<string> {
  const aiRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPTS[mode] }],
        },
        { role: "user", content: userContent },
      ],
      text: {
        format: {
          type: "json_schema",
          name: SCHEMA_NAMES[mode],
          strict: true,
          schema: OUTPUT_SCHEMAS[mode],
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
  const outText = extractOutputText(ai);
  if (!outText) throw new Error("AI returned no usable content.");
  return outText;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // --- Parse input -----------------------------------------------------------
  let mode: string;
  let child_id: string;
  let upload_id: string | undefined;
  let subject: string | undefined;
  let question: string | undefined;

  try {
    const body = await req.json();
    mode = ["flashcards", "solve", "summarize", "ask"].includes(body.mode)
      ? body.mode
      : "flashcards";
    child_id = body.child_id;
    if (mode === "ask") {
      question = String(body.question ?? "").trim();
      if (!child_id || !question) throw new Error("missing fields");
    } else {
      upload_id = body.upload_id;
      subject = body.subject;
      if (!upload_id || !child_id) throw new Error("missing fields");
    }
  } catch {
    return json({ error: "Required fields missing" }, 400);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Not authenticated" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- AI key gate -----------------------------------------------------------
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

  // ===========================================================================
  // ASK mode — text question only, no file
  // ===========================================================================
  if (mode === "ask") {
    // Auth: parent JWT (RLS owns_child) OR anon child with live session.
    const { data: ownedChild } = await userClient
      .from("children")
      .select("id")
      .eq("id", child_id)
      .maybeSingle();

    let authorized = !!ownedChild;
    if (!authorized) {
      const { data: liveSession } = await admin
        .from("active_sessions")
        .select("child_id")
        .eq("child_id", child_id)
        .maybeSingle();
      authorized = !!liveSession;
    }
    if (!authorized) return json({ error: "Not authorized" }, 403);

    try {
      const outText = await callOpenAI(
        openAiKey,
        "ask",
        [{ type: "input_text", text: question! }],
      );
      const parsed = JSON.parse(outText);
      return json({ success: true, mode: "ask", result: parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generation failed.";
      console.error("ask failed:", message);
      return json({ error: "generation_failed", message }, 500);
    }
  }

  // ===========================================================================
  // UPLOAD modes — flashcards | solve | summarize
  // ===========================================================================

  // --- Authz: prove caller owns this upload ----------------------------------
  type UploadRow = { id: string; child_id: string; file_path: string; subject: string | null };
  let upload: UploadRow | null = null;

  // Path 1: authenticated parent — RLS proves ownership.
  const { data: ownedUpload, error: ownErr } = await userClient
    .from("uploads")
    .select("id, child_id, file_path, subject")
    .eq("id", upload_id!)
    .maybeSingle();
  if (ownErr) return json({ error: "Authorization check failed" }, 500);

  if (ownedUpload && ownedUpload.child_id === child_id) {
    upload = ownedUpload;
  } else {
    // Path 2: account-less child — a live active_sessions row proves they
    // redeemed this child's code (same pattern as save_child_session).
    const { data: liveSession } = await admin
      .from("active_sessions")
      .select("child_id")
      .eq("child_id", child_id)
      .maybeSingle();
    if (liveSession) {
      const { data: anonUpload } = await admin
        .from("uploads")
        .select("id, child_id, file_path, subject")
        .eq("id", upload_id!)
        .maybeSingle();
      if (anonUpload && anonUpload.child_id === child_id) upload = anonUpload;
    }
  }

  if (!upload) return json({ error: "Upload not found" }, 404);

  try {
    // --- Download the note ---------------------------------------------------
    const { data: blob, error: dlErr } = await admin.storage
      .from("uploads")
      .download(upload.file_path);
    if (dlErr || !blob) {
      if (dlErr) console.error("Could not read uploaded file:", dlErr.message);
      throw new Error("Could not read the uploaded file.");
    }

    const meta = classify(upload.file_path);
    if (!meta) throw new Error("Unsupported file type (use an image or PDF).");

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dataUrl = `data:${meta.mime};base64,${toBase64(bytes)}`;
    const subj = subject || upload.subject || "these notes";

    // --- User message text per mode -----------------------------------------
    const userTextByMode: Record<string, string> = {
      flashcards:
        `These are a student's notes for ${subj}. Read them carefully and ` +
        `produce exactly 20 flashcards (question/answer) plus a study guide ` +
        `with a short summary, a list of key concepts, and 5 practice ` +
        `questions. Base everything strictly on the notes.`,
      solve:
        `This is a student's homework problem or question for ${subj}. ` +
        `Use the Socratic method to guide them — do NOT give the answer, ` +
        `just help them think through it step by step.`,
      summarize:
        `These are a student's notes for ${subj}. ` +
        `Summarize the key concepts into a clear, concise overview.`,
    };

    const fileContent =
      meta.kind === "image"
        ? { type: "input_image", image_url: dataUrl }
        : {
            type: "input_file",
            filename: upload.file_path.split("/").pop() ?? "notes.pdf",
            file_data: dataUrl,
          };

    // --- Call OpenAI --------------------------------------------------------
    const outText = await callOpenAI(
      openAiKey,
      mode,
      [{ type: "input_text", text: userTextByMode[mode] }, fileContent],
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(outText);
    } catch {
      throw new Error("AI returned malformed JSON.");
    }

    // --- Persist results (flashcards only) -----------------------------------
    if (mode === "flashcards") {
      const flashcards = (
        (parsed.flashcards as { question: string; answer: string }[]) ?? []
      ).filter((f) => f.question && f.answer);
      if (flashcards.length === 0) throw new Error("No flashcards were generated.");

      const { error: fcErr } = await admin.from("flashcards").insert(
        flashcards.map((f) => ({
          upload_id: upload_id!,
          child_id,
          question: f.question,
          answer: f.answer,
        })),
      );
      if (fcErr) {
        console.error("Saving flashcards failed:", fcErr.message);
        throw new Error("Saving flashcards failed.");
      }

      const { data: guide, error: sgErr } = await admin
        .from("study_guides")
        .insert({
          upload_id: upload_id!,
          child_id,
          subject: subj,
          content: JSON.stringify(parsed.study_guide ?? {}),
        })
        .select("id")
        .single();
      if (sgErr) {
        console.error("Saving study guide failed:", sgErr.message);
        throw new Error("Saving study guide failed.");
      }

      await admin
        .from("uploads")
        .update({ processed: true, error: null })
        .eq("id", upload_id!);

      return json({
        success: true,
        flashcard_count: flashcards.length,
        guide_id: guide.id,
      });
    }

    // solve / summarize — return result directly, no DB write needed
    await admin
      .from("uploads")
      .update({ processed: true, error: null })
      .eq("id", upload_id!);

    return json({ success: true, mode, result: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed.";
    console.error("generate-content failed:", message);
    await admin
      .from("uploads")
      .update({ processed: false, error: message })
      .eq("id", upload_id!);
    return json({ error: "generation_failed", message }, 500);
  }
});

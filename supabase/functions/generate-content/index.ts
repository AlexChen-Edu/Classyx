// ===========================================================================
// generate-content — Classyx AI generation (server-side ONLY)
// ---------------------------------------------------------------------------
// Modes:
//   flashcards   — 20 Q&A flashcards, saved to DB
//   solve        — Socratic guidance on a problem, returned directly
//   solve_reveal — complete worked solution, returned directly
//   summarize    — concise summary + key points, returned directly
//   ask          — text question answered without a file upload
//
// Input (POST JSON):
//   { mode, child_id, upload_id?, subject? }           — flashcards/solve/summarize
//   { mode: 'ask', child_id, question, context? }       — ask (context = prior turns)
//
// SECURITY:
//   * OPENAI_API_KEY lives ONLY here (Deno.env), never in the browser.
//   * Until OPENAI_API_KEY is set, returns HTTP 503 "not configured".
//   * Monthly credit limits are enforced before each OpenAI call.
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

// Monthly AI credit limits per plan. Unknown/missing plan → FREE_LIMIT.
const PLAN_AI_LIMITS: Record<string, number> = {
  student: 300,
  family: 900,
};
const FREE_LIMIT = 10;

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
    "student's uploaded class notes (an image or PDF) and turn them into flashcards. " +
    "Be accurate to the source notes; do not invent facts that are not supported by " +
    "the notes. Keep questions and answers concise and clear for the student's level.",
  solve:
    "You are a Socratic tutor. Do NOT give the answer directly. Instead, look at " +
    "the problem and guide the student to figure it out themselves. Ask a leading " +
    "question, explain the concept behind it, and show the first step only. " +
    "Return JSON with { concept: string, hint: string, first_step: string, guiding_question: string }",
  solve_reveal:
    "You are a tutor. Give the complete step-by-step solution to this problem. " +
    "Show all work clearly. Return JSON with { solution: string, steps: string[] }",
  summarize:
    "Summarize the key concepts from these notes into a clear, concise study guide. " +
    "Return JSON with { summary: string, key_points: string[] }",
  ask:
    "You are a smart, friendly tutor for students. Answer questions clearly and correctly.\n\n" +
    "LATEX MATH NOTATION — always use LaTeX for all mathematical expressions:\n" +
    "- Wrap inline math in \\(...\\) — e.g. \\(x = 2\\)\n" +
    "- Wrap display (block) math in \\[...\\] — e.g. \\[x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\\]\n" +
    "- Use display math for standalone formulas; use inline math when referring to a variable mid-sentence\n" +
    "- Never write raw plain-text formulas like x = (-b ± √(b²-4ac)) / 2a — always use LaTeX\n\n" +
    "DETECT THE SUBJECT TYPE AND RESPOND ACCORDINGLY:\n\n" +
    "MATH — always lead with the formula(s) first:\n" +
    "- Show the canonical form of the formula as a display math block — ONE formula per concept\n" +
    "- If a formula has a ± version (e.g. quadratic formula), show ONLY the ± version; do NOT split it into a + variant and a − variant separately\n" +
    "- Only show genuinely distinct variants (e.g. standard form vs vertex form of a quadratic) — never duplicate a formula just to show both signs\n" +
    "- Define each variable immediately after (one per line, using inline math for the variable)\n" +
    "- Give a worked example with real numbers\n" +
    "- Brief concept explanation last\n" +
    "- Example: 'quadratic formula' → show \\[x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\\] FIRST, not a definition\n\n" +
    "SCIENCE:\n" +
    "- Biology: structure → function → why it matters\n" +
    "- Chemistry: show the equation/reaction first, then explain\n" +
    "- Physics: formula first, then concept\n" +
    "- Lead with the key fact, never start with a dictionary definition\n\n" +
    "HISTORY:\n" +
    "- Who, what, when, where in one sentence first\n" +
    "- Then context and significance\n" +
    "- Keep it concise, no walls of text\n\n" +
    "ENGLISH / LITERATURE:\n" +
    "- Define the term clearly in plain language first\n" +
    "- Give a concrete example from a well-known text\n" +
    "- Explain why it matters for writing or analysis\n\n" +
    "LANGUAGES (Spanish, French, etc.):\n" +
    "- Show the word or phrase first, bolded\n" +
    "- Give a pronunciation hint if useful\n" +
    "- Show usage in a sentence immediately after\n\n" +
    "GENERAL 'explain X' questions:\n" +
    "- One sentence plain-English definition first\n" +
    "- Then an analogy that makes it click\n" +
    "- Key points after\n\n" +
    "UNIVERSAL RULES:\n" +
    "- Never start with a dictionary-style definition when a formula or fact would be more useful\n" +
    "- Never use jargon without immediately explaining it\n" +
    "- If a question is ambiguous (e.g. 'quad form' could mean quadratic form OR quadratic formula), answer BOTH briefly and ask which one they meant\n" +
    "- Always be correct. If you are not sure, say so.\n" +
    "- Keep answers student-friendly but never dumbed down\n\n" +
    "OUTPUT FORMAT — always return JSON with these fields:\n" +
    "- response_type: 'simple' for short factual lookups (1-2 sentences), 'detailed' for anything that needs structure\n" +
    "- headline: for simple, bold the key term plus an ultra-short definition (e.g. '**Mitosis** — cell division that produces two identical daughter cells'); for detailed, plain topic name\n" +
    "- answer: your full answer following the subject rules above; use **bold** for key terms; separate paragraphs with a blank line\n" +
    "- key_points: 3-5 short memorable takeaways (may be empty for simple responses)\n" +
    "- follow_up_questions: 2-3 natural follow-up questions a student might ask next",
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
    },
    required: ["flashcards"],
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
  solve_reveal: {
    type: "object",
    additionalProperties: false,
    properties: {
      solution: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
    },
    required: ["solution", "steps"],
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
      response_type: { type: "string", enum: ["simple", "detailed"] },
      headline: { type: "string" },
      answer: { type: "string" },
      key_points: { type: "array", items: { type: "string" } },
      follow_up_questions: { type: "array", items: { type: "string" } },
    },
    required: ["response_type", "headline", "answer", "key_points", "follow_up_questions"],
  },
};

const SCHEMA_NAMES: Record<string, string> = {
  flashcards: "study_pack",
  solve: "solve_response",
  solve_reveal: "solve_reveal_response",
  summarize: "summarize_response",
  ask: "ask_response",
};

type ConversationTurn = { role: "user" | "assistant"; content: string };

async function callOpenAI(
  openAiKey: string,
  mode: string,
  userContent: unknown[],
  context: ConversationTurn[] = [],
): Promise<string> {
  // Interleave prior conversation turns before the current user message so the
  // model knows what was already discussed (ask follow-up thread).
  const contextMessages = context.map((turn) => ({
    role: turn.role,
    content: [{ type: turn.role === "assistant" ? "output_text" : "input_text", text: turn.content }],
  }));

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
        ...contextMessages,
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
  let context: ConversationTurn[] = [];

  try {
    const body = await req.json();
    mode = ["flashcards", "solve", "solve_reveal", "summarize", "ask"].includes(body.mode)
      ? body.mode
      : "flashcards";
    child_id = body.child_id;
    if (mode === "ask") {
      question = String(body.question ?? "").trim();
      if (!child_id || !question) throw new Error("missing fields");
      // Optional conversation history for follow-up threading
      if (Array.isArray(body.context)) {
        context = (body.context as unknown[])
          .filter((t): t is ConversationTurn =>
            typeof t === "object" && t !== null &&
            ((t as ConversationTurn).role === "user" || (t as ConversationTurn).role === "assistant") &&
            typeof (t as ConversationTurn).content === "string"
          )
          .slice(0, 20); // cap history at 20 turns (10 exchanges)
      }
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

  // ---------------------------------------------------------------------------
  // Credit check helper — runs after authorization, before every OpenAI call.
  // Returns { familyId } if within limit, or a Response if over limit.
  // ---------------------------------------------------------------------------
  async function checkCredits(childId: string): Promise<{ familyId: string } | Response> {
    const { data: childRow } = await admin
      .from("children")
      .select("family_id")
      .eq("id", childId)
      .single();
    if (!childRow) return json({ error: "Child not found" }, 404);

    const familyId = childRow.family_id as string;
    const { data: familyRow } = await admin
      .from("families")
      .select("plan")
      .eq("id", familyId)
      .single();

    const limit = familyRow
      ? (PLAN_AI_LIMITS[familyRow.plan as string] ?? FREE_LIMIT)
      : FREE_LIMIT;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { count } = await admin
      .from("ai_usage")
      .select("*", { count: "exact", head: true })
      .eq("child_id", childId)
      .gte("used_at", monthStart);

    if ((count ?? 0) >= limit) {
      return json(
        {
          error: "credits_exhausted",
          message:
            "You've used all your study credits this month. Ask a parent to upgrade your plan.",
        },
        429,
      );
    }

    return { familyId };
  }

  async function recordUsage(childId: string, familyId: string) {
    await admin.from("ai_usage").insert({ child_id: childId, family_id: familyId });
  }

  // ===========================================================================
  // ASK mode — text question only, no file
  // ===========================================================================
  if (mode === "ask") {
    // Auth: verify via getUser() (validates JWT with Supabase Auth, not just
    // decodes it) then check ownership with admin — avoids the RLS recursion
    // issue that caused the userClient children query to silently return null.
    // Fallback: account-less child with a live active_sessions row.
    const { data: { user } } = await userClient.auth.getUser();

    let authorized = false;
    if (user) {
      // Authenticated parent: verify the child belongs to their family.
      const { data: familyRow } = await admin
        .from("families")
        .select("id")
        .eq("parent_id", user.id)
        .maybeSingle();
      if (familyRow) {
        const { data: childRow } = await admin
          .from("children")
          .select("id")
          .eq("id", child_id)
          .eq("family_id", familyRow.id)
          .maybeSingle();
        authorized = !!childRow;
      }
    } else {
      // Account-less child: must have a live study session.
      const { data: liveSession } = await admin
        .from("active_sessions")
        .select("child_id")
        .eq("child_id", child_id)
        .maybeSingle();
      authorized = !!liveSession;
    }
    if (!authorized) return json({ error: "Not authorized" }, 403);

    // Credit check
    const creditResult = await checkCredits(child_id);
    if (creditResult instanceof Response) return creditResult;
    const { familyId } = creditResult;

    try {
      const outText = await callOpenAI(
        openAiKey,
        "ask",
        [{ type: "input_text", text: question! }],
        context,
      );
      const parsed = JSON.parse(outText);

      // Record usage after successful generation
      await recordUsage(child_id, familyId).catch((e) =>
        console.error("ai_usage insert failed:", e)
      );

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

  // Credit check (after ownership proof, before the expensive AI call)
  const creditResult = await checkCredits(child_id);
  if (creditResult instanceof Response) return creditResult;
  const { familyId } = creditResult;

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
        `produce exactly 20 flashcards (question/answer). ` +
        `Base everything strictly on the notes.`,
      solve:
        `This is a student's homework problem or question for ${subj}. ` +
        `Use the Socratic method to guide them — do NOT give the answer, ` +
        `just help them think through it step by step.`,
      solve_reveal:
        `This is a student's homework problem or question for ${subj}. ` +
        `Give the complete step-by-step solution. Show all work clearly.`,
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

      await admin
        .from("uploads")
        .update({ processed: true, error: null })
        .eq("id", upload_id!);

      // Record usage after successful generation
      await recordUsage(child_id, familyId).catch((e) =>
        console.error("ai_usage insert failed:", e)
      );

      return json({
        success: true,
        flashcard_count: flashcards.length,
      });
    }

    // solve / summarize — return result directly, no DB write needed
    await admin
      .from("uploads")
      .update({ processed: true, error: null })
      .eq("id", upload_id!);

    // Record usage after successful generation
    await recordUsage(child_id, familyId).catch((e) =>
      console.error("ai_usage insert failed:", e)
    );

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

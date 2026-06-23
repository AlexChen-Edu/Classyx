import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, turnstileToken } = await req.json();

    // Verify Turnstile token server-side
    const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
    if (turnstileSecret && turnstileToken) {
      const verifyRes = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: turnstileSecret, response: turnstileToken }),
        }
      );
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        console.error("Turnstile failed:", JSON.stringify(verifyData));
        return new Response(JSON.stringify({ error: "Bot verification failed" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "Invalid email" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const token = crypto.randomUUID();
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error: dbError } = await supabase
      .from("waitlist")
      .insert({ email, token, confirmed: false, expires_at });

    if (dbError) {
      console.error("DB error:", dbError);
      if (dbError.code === "23505") {
        return new Response(JSON.stringify({ error: "Already signed up" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Database error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:5173";
    const confirmUrl = `${siteUrl}/confirm.html?token=${token}`;

    const emailHtml =
      "<div style='font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px'>" +
      "<h1 style='font-size:24px;color:#1a1a1a;margin-bottom:8px'>You're almost on the list.</h1>" +
      "<p style='color:#555;font-size:15px;line-height:1.6'>Click the button below to confirm your spot. This link expires in 24 hours.</p>" +
      "<a href='" + confirmUrl + "' style='display:inline-block;margin:24px 0;padding:14px 28px;background:#2d6a4f;color:#fff;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600'>Confirm my spot</a>" +
      "<p style='color:#999;font-size:13px'>If you didn't sign up for Classyx, ignore this email.</p>" +
      "</div>";

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      },
      body: JSON.stringify({
        from: "Classyx <hello@getclassyx.com>",
        to: email,
        subject: "Confirm your spot on the Classyx waitlist",
        html: emailHtml,
      }),
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      console.error("Resend error:", err);
      return new Response(JSON.stringify({ error: "Failed to send email" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Notify yourself - fire and forget
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      },
      body: JSON.stringify({
        from: "Classyx <hello@getclassyx.com>",
        to: "alexlchen0416@icloud.com",
        subject: "New waitlist signup: " + email,
        html: "<p>New signup: <strong>" + email + "</strong></p>",
      }),
    }).catch((err) => console.error("Notification error:", err));

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

const DEFAULT_MODEL =
  Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash-lite";

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return json(
      {
        error: "Method not allowed",
      },
      405,
    );
  }

  try {
    if (!GEMINI_API_KEY) {
      return json(
        {
          error:
            "AI service is not configured. Add GEMINI_API_KEY to Supabase Edge Function secrets.",
        },
        503,
      );
    }

    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return json(
        {
          error: "Missing authorization token.",
        },
        401,
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();

    const supabaseUser = createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const {
      data: { user },
      error: userError,
    } = await supabaseUser.auth.getUser(token);

    if (userError || !user) {
      return json(
        {
          error: "Invalid or expired authentication session.",
        },
        401,
      );
    }

    const body = await req.json();

    const prompt =
      typeof body?.prompt === "string"
        ? body.prompt.trim()
        : "";

    const requestedModel =
      typeof body?.model === "string"
        ? body.model.trim()
        : "";

    if (!prompt) {
      return json(
        {
          error: "Prompt is required.",
        },
        400,
      );
    }

    if (prompt.length > 12000) {
      return json(
        {
          error: "Prompt is too long.",
        },
        400,
      );
    }

    const { data: profile, error: profileError } =
      await supabaseAdmin
        .from("profiles")
        .select(
          "id, plan, ai_usage_count, ai_usage_limit, subscription_status",
        )
        .eq("id", user.id)
        .maybeSingle();

    if (profileError) {
      console.error("Profile error:", profileError);

      return json(
        {
          error: "Unable to load account profile.",
        },
        500,
      );
    }

    if (!profile) {
      return json(
        {
          error: "Profile not found.",
        },
        403,
      );
    }

    const currentUsage =
      Number(profile.ai_usage_count ?? 0);

    const defaultLimit =
      profile.plan === "pro"
        ? 500
        : profile.plan === "starter"
          ? 100
          : 20;

    const usageLimit =
      Number(profile.ai_usage_limit ?? defaultLimit);

    if (
      usageLimit > 0 &&
      currentUsage >= usageLimit
    ) {
      return json(
        {
          error:
            "AI monthly usage limit reached.",
          usage: currentUsage,
          limit: usageLimit,
          plan: profile.plan ?? "trial",
        },
        429,
      );
    }

    const model =
      requestedModel || DEFAULT_MODEL;

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const geminiResponse = await fetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2000,
          },
        }),
      },
    );

    const geminiData =
      await geminiResponse.json();

    if (!geminiResponse.ok) {
      console.error(
        "Gemini error:",
        geminiData,
      );

      return json(
        {
          error:
            geminiData?.error?.message ||
            "Gemini request failed.",
        },
        geminiResponse.status >= 400
          ? geminiResponse.status
          : 502,
      );
    }

    const result =
      geminiData?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) =>
          part?.text ?? "",
        )
        .join("")
        .trim();

    if (!result) {
      return json(
        {
          error:
            "The AI provider returned an empty response.",
        },
        502,
      );
    }

    const newUsage = currentUsage + 1;

    const { error: usageError } =
      await supabaseAdmin
        .from("profiles")
        .update({
          ai_usage_count: newUsage,
        })
        .eq("id", user.id);

    if (usageError) {
      console.error(
        "Usage update error:",
        usageError,
      );
    }

    return json({
      success: true,
      result,
      provider: "gemini",
      model,
      usage: newUsage,
      limit: usageLimit,
      remaining:
        usageLimit > 0
          ? Math.max(
              0,
              usageLimit - newUsage,
            )
          : null,
    });
  } catch (error) {
    console.error(
      "AI proxy error:",
      errorMessage(error),
    );

    return json(
      {
        error:
          "Unexpected server error.",
      },
      500,
    );
  }
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, paddle-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const PADDLE_WEBHOOK_SECRET =
  Deno.env.get("PADDLE_WEBHOOK_SECRET") ?? "";

const STARTER_PRICE_ID =
  Deno.env.get("PADDLE_STARTER_PRICE_ID") ?? "";

const PRO_PRICE_ID =
  Deno.env.get("PADDLE_PRO_PRICE_ID") ?? "";

const supabase = createClient(
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

function timingSafeEqual(
  a: Uint8Array,
  b: Uint8Array,
) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

function hexToBytes(hex: string) {
  const clean = hex.trim();

  if (
    clean.length === 0 ||
    clean.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(clean)
  ) {
    return null;
  }

  const bytes = new Uint8Array(clean.length / 2);

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(
      clean.substring(i * 2, i * 2 + 2),
      16,
    );
  }

  return bytes;
}

async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
) {
  const parts = signatureHeader
    .split(";")
    .map((part) => part.trim());

  let timestamp = "";
  const signatures: string[] = [];

  for (const part of parts) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.substring(0, index);
    const value = part.substring(index + 1);

    if (key === "ts") {
      timestamp = value;
    }

    if (key === "h1") {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const timestampNumber =
    Number(timestamp);

  if (!Number.isFinite(timestampNumber)) {
    return false;
  }

  const now = Math.floor(
    Date.now() / 1000,
  );

  const maxAge = 5 * 60;

  if (
    Math.abs(now - timestampNumber) >
    maxAge
  ) {
    return false;
  }

  const signedPayload =
    `${timestamp}:${rawBody}`;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signatureBuffer =
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signedPayload),
    );

  const expected =
    new Uint8Array(signatureBuffer);

  for (const signature of signatures) {
    const received =
      hexToBytes(signature);

    if (
      received &&
      timingSafeEqual(
        expected,
        received,
      )
    ) {
      return true;
    }
  }

  return false;
}

function getPlanFromPrice(
  priceId: string,
) {
  if (
    STARTER_PRICE_ID &&
    priceId === STARTER_PRICE_ID
  ) {
    return "starter";
  }

  if (
    PRO_PRICE_ID &&
    priceId === PRO_PRICE_ID
  ) {
    return "pro";
  }

  return null;
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
    if (!PADDLE_WEBHOOK_SECRET) {
      return json(
        {
          error:
            "PADDLE_WEBHOOK_SECRET is not configured.",
        },
        503,
      );
    }

    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return json(
        {
          error:
            "SUPABASE_SERVICE_ROLE_KEY is not configured.",
        },
        503,
      );
    }

    const signature =
      req.headers.get(
        "Paddle-Signature",
      );

    if (!signature) {
      return json(
        {
          error:
            "Missing Paddle-Signature header.",
        },
        401,
      );
    }

    const rawBody =
      await req.text();

    const valid =
      await verifyPaddleSignature(
        rawBody,
        signature,
        PADDLE_WEBHOOK_SECRET,
      );

    if (!valid) {
      return json(
        {
          error:
            "Invalid Paddle signature.",
        },
        401,
      );
    }

    const body =
      JSON.parse(rawBody);

    const eventType =
      body?.event_type ?? "";

    const data =
      body?.data ?? {};

    const subscriptionId =
      data?.id ??
      data?.subscription_id ??
      null;

    const customerId =
      data?.customer_id ??
      data?.customer?.id ??
      null;

    const customData =
      data?.custom_data ??
      data?.customData ??
      {};

    const userId =
      customData?.user_id ??
      customData?.userId ??
      null;

    const email =
      data?.customer?.email ??
      data?.customer_email ??
      data?.email ??
      null;

    const priceId =
      data?.items?.[0]?.price?.id ??
      data?.items?.[0]?.price_id ??
      null;

    let plan: string | null = null;

    if (priceId) {
      plan = getPlanFromPrice(priceId);
    }

    /*
      Never silently upgrade an unknown price.
    */

    if (
      eventType.startsWith(
        "subscription.",
      ) &&
      priceId &&
      !plan
    ) {
      return json(
        {
          error:
            "Unknown Paddle Price ID.",
        },
        400,
      );
    }

    let status =
      "inactive";

    if (
      eventType ===
        "subscription.created" ||
      eventType ===
        "subscription.activated" ||
      eventType ===
        "subscription.updated" ||
      eventType ===
        "subscription.resumed"
    ) {
      status = "active";
    }

    if (
      eventType ===
        "subscription.past_due"
    ) {
      status = "past_due";
    }

    if (
      eventType ===
        "subscription.canceled"
    ) {
      status = "canceled";
    }

    if (
      eventType ===
        "subscription.paused"
    ) {
      status = "paused";
    }

    /*
      Ignore unrelated Paddle events.
    */

    if (
      !eventType.startsWith(
        "subscription.",
      )
    ) {
      return json({
        success: true,
        ignored: true,
        event_type: eventType,
      });
    }

    const updateData: Record<
      string,
      unknown
    > = {
      subscription_status: status,
    };

    if (plan) {
      updateData.plan = plan;
    }

    if (subscriptionId) {
      updateData.paddle_subscription_id =
        subscriptionId;
    }

    if (customerId) {
      updateData.paddle_customer_id =
        customerId;
    }

    let updateQuery;

    if (userId) {
      updateQuery = supabase
        .from("profiles")
        .update(updateData)
        .eq("id", userId);
    } else if (email) {
      updateQuery = supabase
        .from("profiles")
        .update(updateData)
        .eq("email", email);
    } else {
      return json(
        {
          error:
            "No user_id or customer email found.",
        },
        400,
      );
    }

    const { error } =
      await updateQuery;

    if (error) {
      console.error(
        "Supabase update error:",
        error,
      );

      return json(
        {
          error:
            "Unable to update subscription.",
        },
        500,
      );
    }

    return json({
      success: true,
      event_type: eventType,
      status,
      plan,
    });
  } catch (error) {
    console.error(
      "Paddle webhook error:",
      error,
    );

    return json(
      {
        error:
          "Invalid webhook request.",
      },
      400,
    );
  }
});

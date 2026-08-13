// ============================================================
// AI Rental Cloud - Paddle Webhook Handler
// الوظيفة: Paddle بينادي على العنوان ده تلقائيًا لما يحصل اشتراك
// جديد أو إلغاء أو تجديد، وإحنا بنحدّث حالة المستخدم في القاعدة.
// ضيف الرابط بتاع الـ function ده في Paddle Dashboard -> Notifications
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

// خرائط أسعار Paddle -> اسم الباقة عندك (عدّلها بأسعارك الحقيقية)
const PRICE_TO_PLAN: Record<string, string> = {
  // "pri_xxxxxxxxxxxx": "starter",
  // "pri_yyyyyyyyyyyy": "pro",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const eventType = body?.event_type;
    const data = body?.data;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // مفتاح خاص للسيرفر فقط، له صلاحية كتابة كاملة
    );

    const customEmail = data?.customer?.email || data?.email;
    const priceId = data?.items?.[0]?.price?.id;
    const plan = priceId ? (PRICE_TO_PLAN[priceId] || "starter") : "starter";

    if (!customEmail) {
      return new Response(JSON.stringify({ ok: true, note: "no email in payload" }), { headers: CORS_HEADERS });
    }

    let status = "inactive";
    if (eventType === "subscription.created" || eventType === "subscription.activated" || eventType === "subscription.updated") {
      status = "active";
    } else if (eventType === "subscription.canceled" || eventType === "subscription.past_due") {
      status = eventType === "subscription.past_due" ? "past_due" : "canceled";
    }

    await supabase
      .from("profiles")
      .update({
        subscription_status: status,
        plan: status === "active" ? plan : "trial",
        paddle_customer_id: data?.customer_id || null,
        paddle_subscription_id: data?.id || null,
      })
      .eq("email", customEmail);

    return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS_HEADERS });
  }
});

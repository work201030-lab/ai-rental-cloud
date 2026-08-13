import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const PLAN_LIMITS: Record<string, number> = { trial: 10, starter: 200, pro: 1000 };
const CORS_HEADERS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:CORS_HEADERS});
  try{
    const authHeader=req.headers.get("Authorization")??"";
    const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:authHeader}}});
    const {data:{user},error:authErr}=await supabase.auth.getUser();
    if(authErr||!user)return json({error:"Unauthorized"},401);
    const {data:profile,error:profErr}=await supabase.from("profiles").select("*").eq("id",user.id).single();
    if(profErr||!profile)return json({error:"Profile not found"},404);
    const now=new Date(); let usage=Number(profile.ai_usage_count||0); let resetAt=new Date(profile.usage_reset_at);
    if(now>resetAt){usage=0;resetAt=new Date(now.getTime()+30*24*60*60*1000);}
    const limit=PLAN_LIMITS[profile.plan]??0;
    if(profile.subscription_status!=="active"&&profile.plan!=="trial")return json({error:"الاشتراك غير مفعّل. من فضلك اشترك للمتابعة."},402);
    if(usage>=limit)return json({error:"وصلت للحد الأقصى من طلبات AI لهذا الشهر. قم بترقية باقتك."},429);
    const {prompt,model}=await req.json(); if(!prompt)return json({error:"Missing prompt"},400);
    const apiKey=Deno.env.get("GEMINI_API_KEY"); if(!apiKey)return json({error:"GEMINI_API_KEY is not configured on the server."},500);
    const result=await callGemini(prompt,model,apiKey);
    const {error:updateErr}=await supabase.from("profiles").update({ai_usage_count:usage+1,usage_reset_at:resetAt.toISOString()}).eq("id",user.id);
    if(updateErr)return json({error:updateErr.message},500);
    return json({result,provider:"gemini",remaining:limit-usage-1});
  }catch(e){return json({error:String(e)},500);}
});
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...CORS_HEADERS,"Content-Type":"application/json"}});}
async function callGemini(prompt:string,model:string|undefined,apiKey:string){
  const mm=model&&model!=="auto"?model:"gemini-2.5-flash-lite";
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mm}:generateContent?key=${apiKey}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})});
  const d=await r.json(); if(!r.ok)throw new Error(d?.error?.message||"Gemini error");
  return d.candidates?.[0]?.content?.parts?.map((x:{text?:string})=>x.text||"").join("")||"";
}

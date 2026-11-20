import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-haiku-5-5";
const TOL = 0.05;

const KEYS = {
  calories: "kcalPer100",
  protein: "proteinPer100",
  carbs: "carbsPer100",
  fat: "fatPer100"
};

const SYSTEM = `أنت مساعد تغذية رياضية. ترد بـ JSON فقط بدون أي نص أو markdown.
الشكل المطلوب:
{"foods":[{"name":"اسم الصنف بلغة المستخدم","grams":number,"kcalPer100":number,"proteinPer100":number,"carbsPer100":number,"fatPer100":number,"reason":"سبب التغيير أو بدون تغيير أو جديد"}],"summary":"جملة قصيرة بالعربي"}
القيم لكل 100 جم من الصنف حسب المتوسط الغذائي المعروف.`;

async function callModel(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

const isValidFoods = arr =>
  Array.isArray(arr) && arr.length > 0 &&
  arr.every(f => f && typeof f.name === "string" && f.grams > 0 &&
    Object.values(KEYS).every(k => Number.isFinite(f[k])));

function sumNutr(foods) {
  return foods.reduce((t, f) => {
    const k = f.grams / 100;
    for (const n in KEYS) t[n] += f[KEYS[n]] * k;
    return t;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

async function handlePlan({ request, foods = [], target }) {
  if (!request || !target) throw new Error("بيانات ناقصة");
  let feedback = "";
  let last = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = [
      `الأكل الحالي اليوم: ${JSON.stringify(foods)}`,
      `الهدف لليوم (بدون المكملات): ${JSON.stringify(target)}`,
      `طلب المستخدم: ${request}`,
      "طبّق الطلب. إذا زاد صنف، قلّل أصناف أخرى بقدر يحافظ على الهدف. لا تنزل البروتين عن الهدف. لا تقلل أي صنف لأقل من 50% من كميته الأصلية إلا إذا طلب المستخدم ذلك. إذا الطلب إضافة صنف جديد، أضفه مع قيمه الغذائية.",
      feedback
    ].filter(Boolean).join("\n");

    try {
      const result = await callModel(prompt);
      if (!isValidFoods(result.foods)) {
        feedback = "الرد ما كان بالشكل المطلوب، أعد الرد بالـ JSON الصحيح.";
        continue;
      }
      const totals = sumNutr(result.foods);
      const ok = Object.keys(KEYS).every(k =>
        Math.abs(totals[k] - target[k]) <= Math.max(target[k], 1) * TOL);
      last = { ok, foods: result.foods, summary: result.summary, totals };
      if (ok) return last;
      feedback = `مجموع الأكل الحالي ${JSON.stringify(totals)} والهدف ${JSON.stringify(target)}. عدّل الكميات وأعد الرد.`;
    } catch (e) {
      feedback = "حصل خطأ بالرد، أعد المحاولة بالـ JSON الصحيح فقط.";
    }
  }
  if (last) return last;
  throw new Error("ما قدرت أحدّث الخطة، جرّب مرة ثانية");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const html = await readFile(path.join(ROOT, "public", "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "POST" && req.url === "/api/plan") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const out = await handlePlan(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(out));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: e.message || "خطأ غير متوقع" }));
    }
  }

  res.writeHead(404);
  res.end("not found");
});

if (!API_KEY) console.warn("⚠️ ANTHROPIC_API_KEY غير موجود، ضيفه قبل التشغيل");
server.listen(PORT, () => console.log(`Iron Lab يعمل على http://localhost:${PORT}`));
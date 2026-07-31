// OPTIONAL — only if the on-device reader isn't accurate enough for you.
//
// A Cloudflare Worker that reads a label photo with Claude and returns structured
// ingredients. Your API key stays on Cloudflare's side; it never reaches the phone.
//
// SETUP
//   1. dash.cloudflare.com -> Compute (Workers) -> Create -> Start from Hello World
//   2. Paste this file over the default code. Deploy.
//   3. Settings -> Variables and Secrets -> add a Secret:
//        Name: ANTHROPIC_API_KEY     Value: your key from console.anthropic.com
//   4. Settings -> Variables -> add a plain Variable:
//        Name: ALLOWED_ORIGIN        Value: https://tekkship-it.github.io
//   5. Copy your worker URL, then in the app: Log -> Label reader -> paste it.
//
// COST: pennies. Each scan is one small image through Claude Haiku. Cloudflare's
// free tier covers 100k requests/day, which you will not trouble.
//
// This needs a connection. With no signal the app falls back to nothing, so keep
// the on-device reader in mind for offline days.

const MODEL = "claude-haiku-4-5-20251001";

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") {
      return json({ error: "POST an image." }, 405, cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Bad request." }, 400, cors); }

    // --- barcode proxy: only needed if the browser can't reach Open Food Facts directly.
    // Also lets us send the descriptive User-Agent that OFF asks clients for.
    if (body.barcode) {
      const code = String(body.barcode).replace(/\D/g, "");
      if (code.length < 8 || code.length > 14) return json({ error: "Bad barcode." }, 400, cors);
      const fields = typeof body.fields === "string" ? body.fields : "";
      const url = "https://world.openfoodfacts.org/api/v2/product/" + code + ".json"
                + (fields ? "?fields=" + encodeURIComponent(fields) : "");
      try {
        const off = await fetch(url, {
          headers: { "User-Agent": "SkinLog/1.0 (personal skin diary; contact via GitHub)" }
        });
        return json(await off.json(), 200, cors);
      } catch {
        return json({ error: "Couldn't reach the food database." }, 502, cors);
      }
    }

    const image = body.image;
    if (!image || typeof image !== "string") {
      return json({ error: "No image received." }, 400, cors);
    }
    // ~5MB of base64 is plenty for a label; reject anything wild
    if (image.length > 7_000_000) {
      return json({ error: "That photo is too large." }, 413, cors);
    }

    const flags = Array.isArray(body.flags) && body.flags.length
      ? body.flags
      : ["Dairy", "Added sugar", "Gluten / wheat", "Soy", "Nuts"];

    const prompt =
      "This is a photo of a food or drink product. Read the ingredient list.\n\n" +
      "Reply with ONLY a JSON object. No markdown fences, no preamble.\n" +
      '{"name":"<short product name, or a short description if not visible>",' +
      '"ingredients":["<each ingredient exactly as printed>"],' +
      '"flags":["<zero or more, ONLY from the allowed list>"]}\n\n' +
      "Allowed flags: " + flags.join(", ") + "\n\n" +
      "Choose flags from what the ingredients actually contain, including hidden forms " +
      "(milk powder, whey, casein, lactose count as Dairy; glucose syrup, dextrose, " +
      "maltodextrin count as Added sugar). Use High sugar only if sugar is among the first " +
      "three ingredients or the nutrition panel shows a high figure. The label may be in " +
      "English or Swedish; return ingredient names as printed but flags in English.\n" +
      'If no ingredient list is legible, reply {"error":"<one short sentence>"}';

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1200,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
              { type: "text", text: prompt }
            ]
          }]
        })
      });
    } catch {
      return json({ error: "Couldn't reach the model." }, 502, cors);
    }

    if (!upstream.ok) {
      return json({ error: "Reader error " + upstream.status + "." }, 502, cors);
    }

    const data = await upstream.json();
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    try {
      const out = JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
      return json(out, 200, cors);
    } catch {
      return json({ error: "The reply came back garbled. Try a sharper photo." }, 200, cors);
    }
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors }
  });
}

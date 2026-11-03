// Hanami Lobby backend: serves the game, talks to Claude with the server's key,
// and keeps each player's learning progress in Postgres.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const MAX_PER_10_MIN = Number(process.env.MAX_CALLS_PER_10_MIN) || 60;
const MAX_PER_DAY = Number(process.env.MAX_CALLS_PER_DAY) || 3000;
const INDEX = fs.readFileSync(path.join(__dirname, "index.html"));

/* ---------- database ---------- */
let pool = null;
let dbReady = false;
if (process.env.DATABASE_URL) {
  const internal = /\.railway\.internal\b|localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: internal ? false : { rejectUnauthorized: false }, max: 5 });
  pool.query(`CREATE TABLE IF NOT EXISTS progress (
      device_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    .then(() => { dbReady = true; console.log("Database ready"); })
    .catch(err => console.error("Database setup failed:", err.message));
}

/* ---------- NPCs and prompts (kept on the server so the key cannot be used for anything else) ---------- */
const NPCS = {
  kenji: { name: "Kenji", persona: "Kenji, a tired but polite Japanese hotel receptionist at Hanami Hotel, Tokyo. Formal, simple English. Facts: the hotel is overbooked tonight and the player's standard room was given away by mistake. Secret: one suite is still free; its normal extra charge is 18,000 yen. Only if the player stays calm and polite AND clearly asks about any other room, an upgrade, or alternatives, he may offer the suite for a small extra charge between 2,500 and 3,000 yen. If the player is rude or demanding his patience drops and he becomes stiff. He does not know other hotels with vacancies." },
  sarah: { name: "Sarah", persona: "Sarah, a friendly, chatty Australian backpacker sitting in the lobby, casual English with mild slang. If the player asks where to stay, about hostels, beds, or cheap places, she mentions Sakura Hostel right across the street has free beds for about 3,000 yen a night. Otherwise she makes small talk about Tokyo." },
  taro: { name: "Taro", persona: "Taro, a shy young bellboy with very limited English, short broken sentences. If the player politely asks about rooms or help, he whispers a hint that there is one suite still free and that the player should ask Kenji-san about an upgrade." }
};
const LEVEL_RULE = {
  A2: "The player is at CEFR A2: use very simple, common words and short sentences.",
  B1: "The player is at CEFR B1: use everyday English at a natural but clear pace.",
  B2: "The player is at CEFR B2: speak naturally, with common idioms when they fit."
};
const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);
function historyText(npc, history) {
  if (!Array.isArray(history) || !history.length) return "(nothing yet)";
  return history.slice(-8).map(h => (h && h.who === "me" ? "Player: " : npc.name + ": ") + clip(h && h.text, 300)).join("\n");
}
function npcPrompt(b) {
  const npc = NPCS[b.npc];
  const level = LEVEL_RULE[b.level] || LEVEL_RULE.A2;
  const st = b.state || {};
  const state = b.npc === "kenji"
    ? "Kenji patience: " + Math.max(0, Math.min(5, Number(st.patience) || 0)) + "/5. Suite already offered: " + Boolean(st.suite) + "."
    : "Player already knows about the hostel: " + Boolean(st.hostel) + ".";
  return "You play one NPC in a spoken-English practice game. The player is a Vietnamese traveler in a Tokyo hotel lobby at " + clip(b.clock, 5) + ". " +
    "Stay fully in character. " + level + " Reply in natural spoken English, at most 2 short sentences, and usually end with something the player can answer. Never teach or correct inside the reply. If the player does not use English, react confused in character.\n" +
    "The player's line comes from speech-to-text: ignore missing punctuation and capitalization.\n\n" +
    "NPC: " + npc.persona + "\n\nState: " + state + "\n\nConversation so far:\n" + historyText(npc, b.history) +
    "\n\nPlayer just said: \"" + clip(b.text, 300) + "\"\n\n" +
    "Reply with only a JSON object: {\"reply\": string, \"patience_delta\": integer from -2 to 1 (how this line affects the NPC's patience), " +
    "\"agreed\": boolean (true only if the player clearly accepts a concrete room offer from this NPC), \"charge_yen\": number or null (the extra charge agreed), " +
    "\"reveals\": \"suite\" | \"hostel\" | \"none\" (information this reply gives), " +
    "\"score\": 1 | 2 | 3 (3 = natural and polite, 2 = understandable with small issues, 1 = hard to understand or rude), " +
    "\"better\": string (a more natural or polite way to say the player's line, or \"\" if already good), " +
    "\"issue_vi\": string (under 12 words in Vietnamese naming what to improve, or \"\"), " +
    "\"new_word\": string (one useful phrase from your reply worth learning, or \"\")}";
}
function hintPrompt(b) {
  const npc = NPCS[b.npc];
  return "A Vietnamese traveler in a Tokyo hotel lobby needs a place to sleep tonight for at most 3,000 yen extra. They are talking to " + npc.name +
    " (" + npc.persona.split(".")[0] + "). Conversation:\n" + historyText(npc, b.history) +
    "\n\nSuggest ONE short, polite, natural English line they could say next to make progress. Reply with only JSON: {\"line\": string, \"vi\": string (Vietnamese meaning)}";
}

/* ---------- rate limits ---------- */
const hits = new Map();
let dayKey = "", dayCount = 0;
function allow(ip) {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  if (day !== dayKey) { dayKey = day; dayCount = 0; }
  if (dayCount >= MAX_PER_DAY) return false;
  const list = (hits.get(ip) || []).filter(t => now - t < 600000);
  if (list.length >= MAX_PER_10_MIN) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list); dayCount++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some(t => now - t < 600000)) hits.delete(ip); }, 600000).unref();

async function claude(prompt) {
  const r = await fetch(BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("Anthropic " + r.status + ": " + t.slice(0, 200)); }
  const j = await r.json();
  const text = (j.content || []).map(c => c.text || "").join("");
  const a = text.indexOf("{"), z = text.lastIndexOf("}");
  if (a < 0 || z <= a) throw new Error("No JSON in reply");
  return JSON.parse(text.slice(a, z + 1));
}

/* ---------- http ---------- */
function send(res, status, body, type) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type || "application/json; charset=utf-8",
    "cache-control": type ? "no-cache" : "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "microphone=(self)"
  });
  res.end(data);
}
function readJSON(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(Object.assign(new Error("bad json"), { status: 400 })); } });
    req.on("error", reject);
  });
}
const DEVICE_RE = /^[a-zA-Z0-9-]{16,64}$/;
function clientIp(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(res, 200, INDEX, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, ai: Boolean(API_KEY), db: dbReady });

    if (req.method === "POST" && (url.pathname === "/api/npc" || url.pathname === "/api/hint")) {
      if (!API_KEY) return send(res, 503, { error: "ai_unavailable" });
      const b = await readJSON(req, 20000);
      if (!NPCS[b.npc]) return send(res, 400, { error: "unknown_npc" });
      if (url.pathname === "/api/npc" && !clip(b.text, 300).trim()) return send(res, 400, { error: "empty_text" });
      if (!allow(clientIp(req))) return send(res, 429, { error: "rate_limited" });
      const out = await claude(url.pathname === "/api/npc" ? npcPrompt(b) : hintPrompt(b));
      return send(res, 200, out);
    }

    if (url.pathname === "/api/progress") {
      if (!dbReady) return send(res, 503, { error: "db_unavailable" });
      if (req.method === "GET") {
        const device = url.searchParams.get("device") || "";
        if (!DEVICE_RE.test(device)) return send(res, 400, { error: "bad_device" });
        const r = await pool.query("SELECT data, updated_at FROM progress WHERE device_id = $1", [device]);
        return send(res, 200, r.rows[0] ? { data: r.rows[0].data, updatedAt: r.rows[0].updated_at } : { data: null });
      }
      if (req.method === "PUT") {
        const b = await readJSON(req, 300000);
        if (!DEVICE_RE.test(String(b.device || ""))) return send(res, 400, { error: "bad_device" });
        if (!b.data || typeof b.data !== "object") return send(res, 400, { error: "bad_data" });
        await pool.query(
          `INSERT INTO progress (device_id, data, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (device_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [b.device, b.data]);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: "not_found" });
  } catch (err) {
    console.error(req.method, url.pathname, err.message);
    send(res, err.status || 502, { error: err.status ? err.message : "upstream_error" });
  }
});
server.listen(PORT, () => console.log("Hanami Lobby on port " + PORT + (API_KEY ? "" : " (no ANTHROPIC_API_KEY: NPCs use the script)") + (pool ? "" : " (no DATABASE_URL: progress stays in the browser)")));

/**
 * D9 Справочник — бот напоминаний (Cloudflare Worker).
 *
 *  POST /tg      — вебхук Telegram (проверяется секретный заголовок)
 *  POST /feedback — идеи и баги из мини-приложения → пересылаются владельцу (OWNER_ID)
 *  GET  /setup   — регистрирует вебхук и команды бота (можно вызывать повторно)
 *  cron          — раз в 5 минут рассылает созревшие напоминания,
 *                  в 08:45 и 16:45 UTC (11:45 и 19:45 МСК) — о турнирах по рыбалке.
 *
 * Хранилище KV `SUBS`: ключ `u:<chat_id>` → {gift, tax, tour}
 *   gift / tax — время следующего напоминания (мс) или 0, tour — true/false.
 * Секрет `BOT_TOKEN` задаётся командой `wrangler secret put BOT_TOKEN`.
 */
const APP_URL = "https://pochtamur228-png.github.io/d9-guide/";
const GIFT_MS = 4 * 3600e3;          // подарок за онлайн — раз в 4 часа
const TAX_MS = 13 * 24 * 3600e3;     // налог можно оплатить максимум на 14 дней — напоминаем за день
const KINDS = {bug: "🐞 Баг", idea: "💡 Идея", data: "📍 Неточность в данных", other: "💬 Другое"};
const escH = s => String(s).replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"};

/* ---------- отзывы: идеи и баги от игроков ---------- */

// Проверка подписи initData из Telegram Mini App (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function checkInitData(env, initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData), hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const data = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const enc = new TextEncoder();
  const hmac = async (key, msg) => new Uint8Array(await crypto.subtle.sign("HMAC",
    await crypto.subtle.importKey("raw", key, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]), enc.encode(msg)));
  const secret = await hmac(enc.encode("WebAppData"), env.BOT_TOKEN);
  const sig = [...(await hmac(secret, data))].map(b => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 7 * 86400) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch (e) { return null; }
}

// не больше `max` сообщений в час от одного отправителя
async function rateOk(env, who, max) {
  const key = `rl:${who}:${Math.floor(Date.now() / 3600e3)}`;
  const n = Number(await env.SUBS.get(key) || 0);
  if (n >= max) return false;
  await env.SUBS.put(key, String(n + 1), {expirationTtl: 3700});
  return true;
}

const who = u => u ? `${escH([u.first_name, u.last_name].filter(Boolean).join(" ") || "игрок")}${u.username ? " @" + escH(u.username) : ""} <code>${u.id}</code>` : "аноним (не из Telegram)";

// пересылает отзыв владельцу и запоминает, кому отвечать
async function deliver(env, {kind, text, user, ctx}) {
  if (!env.OWNER_ID) return false;
  const msg = `<b>${KINDS[kind] || KINDS.other}</b> от ${who(user)}\n` + (ctx ? `<i>${escH(ctx)}</i>\n` : "") + `\n${escH(text)}` +
    (user ? "\n\n<i>Ответь на это сообщение (Reply) — ответ уйдёт игроку.</i>" : "");
  const r = await tg(env, "sendMessage", {chat_id: env.OWNER_ID, parse_mode: "HTML", text: msg.slice(0, 4000)});
  if (r.ok && user) await env.SUBS.put("fb:" + r.result.message_id, String(user.id), {expirationTtl: 60 * 86400});
  return !!r.ok;
}

async function feedbackHttp(req, env) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {...CORS, "Content-Type": "application/json; charset=utf-8"}});
  let b;
  try { b = await req.json(); } catch (e) { return json({ok: false, error: "bad json"}, 400); }
  const text = String(b.text || "").trim().slice(0, 1500);
  if (text.length < 5) return json({ok: false, error: "Слишком коротко"}, 400);
  const user = await checkInitData(env, String(b.initData || ""));
  const id = user ? "u" + user.id : "ip" + (req.headers.get("CF-Connecting-IP") || "?");
  if (!(await rateOk(env, id, user ? 6 : 3))) return json({ok: false, error: "Слишком часто — попробуй через час"}, 429);
  const ctx = ["раздел: " + String(b.tab || "?").slice(0, 30), String(b.platform || "").slice(0, 20)].filter(Boolean).join(" · ");
  const ok = await deliver(env, {kind: String(b.kind || "other"), text, user, ctx});
  return json({ok, reply: !!user}, ok ? 200 : 502);
}

async function hookSecret(env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("d9-hook:" + env.BOT_TOKEN));
  return [...new Uint8Array(d)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
  });
  return r.json();
}

const getUser = async (env, id) => JSON.parse((await env.SUBS.get("u:" + id)) || '{"gift":0,"tax":0,"tour":false}');
const putUser = (env, id, u) => env.SUBS.put("u:" + id, JSON.stringify(u));

function when(ms) {
  if (!ms) return "выключено";
  const d = new Date(ms);
  return d.toLocaleString("ru-RU", {timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"}) + " МСК";
}

function menu(u) {
  return {
    text:
      "<b>Напоминания DISTRICT 9</b>\n\n" +
      `🎁 Подарок за онлайн: ${u.gift ? "напомню " + when(u.gift) : "выключено"}\n` +
      `🎣 Турниры по рыбалке (11:45 и 19:45 МСК): ${u.tour ? "включено" : "выключено"}\n` +
      `🏠 Налог на дом: ${u.tax ? "напомню " + when(u.tax) : "выключено"}\n\n` +
      "Забрал подарок или оплатил налог — нажми кнопку, и я напомню в следующий раз.",
    reply_markup: {inline_keyboard: [
      [{text: "🎁 Забрал подарок — напомни через 4 ч", callback_data: "gift"}],
      [{text: u.tour ? "🎣 Турниры: выключить" : "🎣 Турниры: включить", callback_data: "tour"}],
      [{text: "🏠 Оплатил налог — напомни через 13 дн", callback_data: "tax"}],
      [{text: "🔕 Выключить всё", callback_data: "off"}],
      [{text: "📖 Открыть справочник", web_app: {url: APP_URL}}],
    ]},
  };
}

const openApp = {inline_keyboard: [[{text: "📖 Открыть справочник", web_app: {url: APP_URL}}]]};

async function onUpdate(env, upd) {
  if (upd.message && upd.message.chat && upd.message.chat.type === "private") {
    const id = upd.message.chat.id, text = (upd.message.text || "").trim();
    const u = await getUser(env, id);
    if (text.startsWith("/start")) {
      await tg(env, "sendMessage", {chat_id: id, parse_mode: "HTML", text:
        "Привет! Я помощник по DISTRICT 9 RP.\n\nСправочник — кнопка «Справочник» внизу или /app.\nНапоминания о подарке, турнирах и налоге — /remind.\nНашёл ошибку или есть идея — /idea или лично @MalkovRonan."});
    }
    // владелец отвечает (Reply) на пересланный отзыв → ответ уходит игроку
    if (String(id) === String(env.OWNER_ID) && upd.message.reply_to_message) {
      const to = await env.SUBS.get("fb:" + upd.message.reply_to_message.message_id);
      if (to) {
        const r = await tg(env, "sendMessage", {chat_id: to, parse_mode: "HTML", text: "💬 <b>Ответ разработчика справочника</b>\n\n" + escH(text)});
        await tg(env, "sendMessage", {chat_id: id, reply_to_message_id: upd.message.message_id,
          text: r.ok ? "✅ Ответ отправлен" : "⚠️ Не доставлено: игрок не запускал бота или заблокировал его"});
        return;
      }
    }
    // /idea текст — сразу; /idea без текста — следующее сообщение станет отзывом
    if (text.startsWith("/idea") || text.startsWith("/bug")) {
      const kind = text.startsWith("/bug") ? "bug" : "idea";
      const body = text.replace(/^\/(idea|bug)(@\w+)?/, "").trim();
      if (!body) {
        await env.SUBS.put("await:" + id, kind, {expirationTtl: 900});
        await tg(env, "sendMessage", {chat_id: id, text: "Напиши одним сообщением, что нашёл или что предлагаешь: баг, идею или неточность в справочнике."});
        return;
      }
      return sendIdea(env, id, upd.message.from, kind, body);
    }
    if (text && !text.startsWith("/")) {
      const kind = await env.SUBS.get("await:" + id);
      if (kind) { await env.SUBS.delete("await:" + id); return sendIdea(env, id, upd.message.from, kind, text); }
    }
    if (text.startsWith("/app")) {
      await tg(env, "sendMessage", {chat_id: id, text: "Справочник: скупщики, карта, гайд, доход.", reply_markup: openApp});
    }
    if (text.startsWith("/remind") || text.startsWith("/start")) {
      const m = menu(u);
      await tg(env, "sendMessage", {chat_id: id, parse_mode: "HTML", text: m.text, reply_markup: m.reply_markup});
    }
    return;
  }
  if (upd.callback_query) {
    const q = upd.callback_query, id = q.message.chat.id;
    const u = await getUser(env, id);
    let note = "";
    if (q.data === "gift") { u.gift = Date.now() + GIFT_MS; note = "Напомню о подарке через 4 часа"; }
    if (q.data === "tax") { u.tax = Date.now() + TAX_MS; note = "Напомню о налоге через 13 дней"; }
    if (q.data === "tour") { u.tour = !u.tour; note = u.tour ? "Буду предупреждать о турнирах" : "Турниры выключены"; }
    if (q.data === "off") { u.gift = 0; u.tax = 0; u.tour = false; note = "Все напоминания выключены"; }
    await putUser(env, id, u);
    await tg(env, "answerCallbackQuery", {callback_query_id: q.id, text: note});
    const m = menu(u);
    await tg(env, "editMessageText", {chat_id: id, message_id: q.message.message_id, parse_mode: "HTML", text: m.text, reply_markup: m.reply_markup});
  }
}

async function sendIdea(env, chatId, from, kind, text) {
  if (!(await rateOk(env, "u" + from.id, 6))) {
    await tg(env, "sendMessage", {chat_id: chatId, text: "Слишком много сообщений за час — попробуй позже."});
    return;
  }
  const ok = await deliver(env, {kind, text: text.slice(0, 1500), user: from, ctx: "через бота"});
  await tg(env, "sendMessage", {chat_id: chatId, text: ok ? "Спасибо! Передал разработчику. Если он ответит — пришлю сюда." : "Не получилось отправить, попробуй позже."});
}

async function eachUser(env, fn) {
  let cursor;
  do {
    const page = await env.SUBS.list({prefix: "u:", cursor});
    for (const k of page.keys) {
      const id = k.name.slice(2);
      const u = JSON.parse((await env.SUBS.get(k.name)) || "null");
      if (u) await fn(id, u);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function tick(env, cron) {
  const now = Date.now();
  const tournament = cron === "45 8 * * *" || cron === "45 16 * * *";
  await eachUser(env, async (id, u) => {
    let changed = false;
    const send = async (text, buttons) => {
      const r = await tg(env, "sendMessage", {chat_id: id, parse_mode: "HTML", text, reply_markup: {inline_keyboard: buttons}});
      if (!r.ok && r.error_code === 403) { await env.SUBS.delete("u:" + id); return false; }  // пользователь заблокировал бота
      return true;
    };
    if (tournament) {
      if (u.tour) await send("🎣 Через 15 минут <b>турнир по рыбалке</b>. Взнос и запись — в планшете, приложение «Рыбалка».", [[{text: "🎣 Выключить турниры", callback_data: "tour"}]]);
      return;
    }
    if (u.gift && u.gift <= now) {
      if (!(await send("🎁 <b>Подарок за онлайн готов!</b> Забери в игре: M → Призы.", [[{text: "🎁 Забрал — напомни через 4 ч", callback_data: "gift"}]]))) return;
      u.gift = 0; changed = true;
    }
    if (u.tax && u.tax <= now) {
      if (!(await send("🏠 <b>Пора продлить налог на дом.</b> Без продления можно потерять имущество.", [[{text: "🏠 Оплатил — напомни через 13 дн", callback_data: "tax"}]]))) return;
      u.tax = 0; changed = true;
    }
    if (changed) await putUser(env, id, u);
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/tg") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await hookSecret(env))) return new Response("forbidden", {status: 403});
      try { await onUpdate(env, await req.json()); } catch (e) { console.log("update error", e); }
      return new Response("ok");
    }
    if (url.pathname === "/feedback") {
      if (req.method === "OPTIONS") return new Response(null, {headers: CORS});
      if (req.method === "POST") return feedbackHttp(req, env);
    }
    if (url.pathname === "/zones") {
      // Территории для захвата с карты d9-rp.com: сайт не отдаёт CORS, поэтому проксируем и кэшируем на минуту.
      const cors = {"Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60"};
      const cache = caches.default, key = new Request(url.origin + "/zones");
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const r = await fetch("https://d9-rp.com/api/wiki/map-markers", {headers: {"User-Agent": "D9-guide-bot"}});
        const d = await r.json();
        const body = JSON.stringify({captureZones: d.captureZones || [], familyFields: d.familyFields || [], at: Date.now()});
        const resp = new Response(body, {headers: cors});
        await cache.put(key, resp.clone());
        return resp;
      } catch (e) {
        return new Response(JSON.stringify({captureZones: [], error: "upstream"}), {status: 502, headers: cors});
      }
    }
    if (url.pathname === "/setup") {
      const hook = await tg(env, "setWebhook", {url: `${url.origin}/tg`, secret_token: await hookSecret(env), allowed_updates: ["message", "callback_query"], drop_pending_updates: true});
      const cmds = await tg(env, "setMyCommands", {commands: [
        {command: "remind", description: "Напоминания: подарок, турниры, налог"},
        {command: "app", description: "Открыть справочник"},
        {command: "idea", description: "Идея или баг — написать разработчику"},
      ]});
      return Response.json({webhook: hook.ok, commands: cmds.ok, description: hook.description});
    }
    return new Response("D9 reminder bot is running");
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, event.cron));
  },
};

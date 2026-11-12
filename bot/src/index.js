/**
 * D9 Справочник — бот напоминаний (Cloudflare Worker).
 *
 *  POST /tg      — вебхук Telegram (проверяется секретный заголовок)
 *  POST /hello    — учёт открытий мини-приложения (для /stats)
 *  /news, /stats — команды только для владельца (OWNER_ID): рассылка всем и статистика
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
const KINDS = {bug: "🐞 Не работает (справочник/бот)", idea: "💡 Идея для справочника/бота", data: "📍 Неверные данные в справочнике", other: "💬 Другое"};
const escH = s => String(s).replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
const SB_URL = "https://qdywdrwjghmnfvkumwbz.supabase.co", SB_KEY = "sb_publishable_HoXSG8I8zV8D_ymVNNGLsw_sqxDtVAQ";  // публичный ключ общей базы
const TOUR_CRONS = ["45 8 * * *", "45 16 * * *"];   // 11:45 и 19:45 МСК — за 15 мин до турниров (12:00, 20:00)
const AIR_CRONS = ["45 12 * * *", "45 16 * * *"];   // 15:45 и 19:45 МСК — за 15 мин до AirDrop (16:00, 20:00)
const NEWS_BATCH = 35;                              // сообщений рассылки за один запуск (лимит подзапросов воркера)
const isOwner = (env, id) => String(id) === String(env.OWNER_ID);
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // дата по Москве
async function bump(env, key) { const n = Number(await env.SUBS.get(key) || 0) + 1; await env.SUBS.put(key, String(n)); }
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
  if (r.ok) await bump(env, "cnt:fb");
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

const getUser = async (env, id) => ({gift: 0, tax: 0, tour: false, air: false, ...JSON.parse((await env.SUBS.get("u:" + id)) || "{}")});
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
      `🎣 Турниры по рыбалке (12:00 и 20:00 МСК): ${u.tour ? "включено" : "выключено"}\n` +
      `📦 AirDrop (16:00 и 20:00 МСК): ${u.air ? "включено" : "выключено"}\n` +
      `🏠 Налог на дом: ${u.tax ? "напомню " + when(u.tax) : "выключено"}\n\n` +
      "О турнирах и AirDrop предупреждаю за 15 минут. Забрал подарок или оплатил налог — нажми кнопку, и я напомню в следующий раз.",
    reply_markup: {inline_keyboard: [
      [{text: "🎁 Забрал подарок — напомни через 4 ч", callback_data: "gift"}],
      [{text: u.tour ? "🎣 Турниры: выключить" : "🎣 Турниры: включить", callback_data: "tour"}],
      [{text: u.air ? "📦 AirDrop: выключить" : "📦 AirDrop: включить", callback_data: "air"}],
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
    if (!(await env.SUBS.get("u:" + id))) await putUser(env, id, u);   // запомнить, чтобы доходили новости
    if (isOwner(env, id) && text.startsWith("/stats")) return sendStats(env, id);
    if (isOwner(env, id) && text.startsWith("/news")) {
      const body = (upd.message.text || "").replace(/^\/news(@\w+)?/, "").trim();
      if (!body) {
        await tg(env, "sendMessage", {chat_id: id, text: "Напиши так: /news текст новости\n\nСначала пришлю предпросмотр, отправка — только после кнопки «Отправить всем». Можно использовать <b>жирный</b> и <i>курсив</i>."});
        return;
      }
      if (await env.SUBS.get("news:job")) {
        await tg(env, "sendMessage", {chat_id: id, text: "Прошлая рассылка ещё идёт — дождись отчёта."});
        return;
      }
      await env.SUBS.put("news:draft", body, {expirationTtl: 86400});
      const n = (await env.SUBS.list({prefix: "u:"})).keys.length;
      const pv = await tg(env, "sendMessage", {chat_id: id, parse_mode: "HTML", text: "📣 <b>Новости справочника</b>\n\n" + body, reply_markup: openApp});
      if (!pv.ok) {
        await tg(env, "sendMessage", {chat_id: id, text: "Telegram не принял текст: " + pv.description + "\nПроверь теги <b>, <i> — они должны быть закрыты."});
        return;
      }
      await tg(env, "sendMessage", {chat_id: id, text: `Выше — так увидят игроки. Получателей: ${n}${n >= 1000 ? "+" : ""}.`, reply_markup: {inline_keyboard: [
        [{text: `📣 Отправить всем`, callback_data: "news_go"}], [{text: "Отмена", callback_data: "news_no"}]]}});
      return;
    }
    if (text.startsWith("/start")) {
      await tg(env, "sendMessage", {chat_id: id, parse_mode: "HTML", text:
        "Привет! Я помощник по DISTRICT 9 RP.\n\nСправочник — кнопка «Справочник» внизу или /app.\nНапоминания о подарке, турнирах, AirDrop и налоге — /remind.\nНашёл ошибку в справочнике или боте, есть идея — /idea или лично @MalkovRonan."});
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
        await tg(env, "sendMessage", {chat_id: id, text: "Напиши одним сообщением, что не так со справочником или ботом, какие данные в нём неверные или что добавить.\n\nЭто связь с разработчиком справочника, а не с администрацией DISTRICT 9: баги игры и жалобы на игроков — на forum.d9-rp.com."});
        return;
      }
      return sendIdea(env, id, upd.message.from, kind, body);
    }
    if (text && !text.startsWith("/")) {
      const kind = await env.SUBS.get("await:" + id);
      if (kind) { await env.SUBS.delete("await:" + id); return sendIdea(env, id, upd.message.from, kind, text); }
    }
    if (text.startsWith("/online")) {
      const o = await serverOnline();
      await tg(env, "sendMessage", {chat_id: id, parse_mode: "HTML", text: o.ok ? `🟢 На сервере DISTRICT 9 сейчас <b>${o.clients}</b> из ${o.maxClients} игроков.` : "Не удалось узнать онлайн — сайт сервера не отвечает."});
      return;
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
    if (q.data === "news_go" || q.data === "news_no") {
      if (!isOwner(env, q.from.id)) return;
      const draft = await env.SUBS.get("news:draft");
      await env.SUBS.delete("news:draft");
      if (q.data === "news_no" || !draft) {
        await tg(env, "answerCallbackQuery", {callback_query_id: q.id, text: draft ? "Отменено" : "Черновик устарел — пришли /news заново"});
        await tg(env, "editMessageText", {chat_id: id, message_id: q.message.message_id, text: "Рассылка отменена."});
        return;
      }
      await env.SUBS.put("news:job", JSON.stringify({text: draft, cursor: null, idx: 0, sent: 0, fail: 0}));
      await tg(env, "answerCallbackQuery", {callback_query_id: q.id, text: "Рассылка запущена"});
      await tg(env, "editMessageText", {chat_id: id, message_id: q.message.message_id, text: `📣 Рассылка запущена. Отправляю по ${NEWS_BATCH} сообщений раз в 5 минут, в конце пришлю отчёт.`});
      await newsBatch(env);
      return;
    }
    const u = await getUser(env, id);
    let note = "";
    if (q.data === "gift") { u.gift = Date.now() + GIFT_MS; note = "Напомню о подарке через 4 часа"; }
    if (q.data === "tax") { u.tax = Date.now() + TAX_MS; note = "Напомню о налоге через 13 дней"; }
    if (q.data === "tour") { u.tour = !u.tour; note = u.tour ? "Буду предупреждать о турнирах" : "Турниры выключены"; }
    if (q.data === "air") { u.air = !u.air; note = u.air ? "Буду предупреждать об AirDrop" : "AirDrop выключен"; }
    if (q.data === "off") { u.gift = 0; u.tax = 0; u.tour = false; u.air = false; note = "Все напоминания выключены"; }
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

// Рассылка частями: воркер может сделать ~50 запросов за запуск, поэтому продолжаем по крону.
async function newsBatch(env) {
  const job = JSON.parse((await env.SUBS.get("news:job")) || "null");
  if (!job) return;
  const page = await env.SUBS.list({prefix: "u:", cursor: job.cursor || undefined});
  const keys = page.keys.slice(job.idx, job.idx + NEWS_BATCH);
  for (const k of keys) {
    const r = await tg(env, "sendMessage", {chat_id: k.name.slice(2), parse_mode: "HTML", text: "📣 <b>Новости справочника</b>\n\n" + job.text, reply_markup: openApp});
    if (r.ok) job.sent++; else { job.fail++; if (r.error_code === 403) await env.SUBS.delete(k.name); }
  }
  job.idx += keys.length;
  if (job.idx >= page.keys.length) {
    if (page.list_complete) {
      await env.SUBS.delete("news:job");
      await tg(env, "sendMessage", {chat_id: env.OWNER_ID, text: `📣 Рассылка завершена: доставлено ${job.sent}, не доставлено ${job.fail} (заблокировали бота — удалены из списка).`});
      return;
    }
    job.cursor = page.cursor; job.idx = 0;
  }
  await env.SUBS.put("news:job", JSON.stringify(job));
}

async function sbCount(table) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?select=*`, {method: "HEAD", headers: {apikey: SB_KEY, Prefer: "count=exact"}});
    return (r.headers.get("content-range") || "").split("/")[1] || "?";
  } catch (e) { return "?"; }
}

async function sendStats(env, chatId) {
  let users = 0, gift = 0, tax = 0, tour = 0, air = 0, cursor;
  do {
    const page = await env.SUBS.list({prefix: "u:", cursor});
    for (const k of page.keys) {
      users++;
      const u = JSON.parse((await env.SUBS.get(k.name)) || "{}");
      if (u.gift) gift++; if (u.tax) tax++; if (u.tour) tour++; if (u.air) air++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && users < 900);
  let app30 = 0, appToday = 0, c2;
  const d = today();
  do {
    const page = await env.SUBS.list({prefix: "app:", cursor: c2});
    app30 += page.keys.length;
    appToday += page.keys.filter(k => k.metadata && k.metadata.d === d).length;
    c2 = page.list_complete ? undefined : page.cursor;
  } while (c2);
  const [pins, prices, votes] = await Promise.all(["pins", "prices", "votes"].map(sbCount));
  const fb = await env.SUBS.get("cnt:fb") || 0;
  await tg(env, "sendMessage", {chat_id: chatId, parse_mode: "HTML", text:
    "📊 <b>Статистика</b>\n\n" +
    `<b>Бот</b>: ${users} ${users >= 900 ? "+ " : ""}чел. запускали\n` +
    `   🎁 подарок: ${gift} · 🏠 налог: ${tax} · 🎣 турниры: ${tour} · 📦 AirDrop: ${air}\n\n` +
    `<b>Справочник</b> (открывали в Telegram):\n   сегодня: ${appToday} · за 30 дней: ${app30}\n\n` +
    `<b>Общая база</b>: меток ${pins} · цен ${prices} · проверок ${votes}\n` +
    `<b>Отзывов</b> получено: ${fb}`});
}

// Мини-приложение отмечается при открытии: одна запись на человека в день, хранится 30 дней.
async function helloHttp(req, env) {
  let b = {};
  try { b = await req.json(); } catch (e) {}
  const user = await checkInitData(env, String(b.initData || ""));
  if (user) {
    const key = "app:" + user.id, d = today();
    const cur = await env.SUBS.getWithMetadata(key);
    if (!cur.metadata || cur.metadata.d !== d) await env.SUBS.put(key, "1", {expirationTtl: 30 * 86400, metadata: {d}});
  }
  return new Response(null, {status: 204, headers: CORS});
}

// онлайн сервера с d9-rp.com (кэш 60 с)
async function serverOnline() {
  const cache = caches.default, key = new Request("https://d9-cache.local/online");
  const hit = await cache.match(key);
  if (hit) return hit.json();
  try {
    const d = await (await fetch("https://d9-rp.com/api/server-status", {headers: {"User-Agent": "D9-guide-bot"}})).json();
    const body = {ok: !!d.ok, clients: d.clients, maxClients: d.maxClients, at: Date.now()};
    await cache.put(key, new Response(JSON.stringify(body), {headers: {"Cache-Control": "public, max-age=60"}}));
    return body;
  } catch (e) { return {ok: false}; }
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
  const tournament = TOUR_CRONS.includes(cron), airdrop = AIR_CRONS.includes(cron);
  if (!tournament && !airdrop) await newsBatch(env);
  await eachUser(env, async (id, u) => {
    let changed = false;
    const send = async (text, buttons) => {
      const r = await tg(env, "sendMessage", {chat_id: id, parse_mode: "HTML", text, reply_markup: {inline_keyboard: buttons}});
      if (!r.ok && r.error_code === 403) { await env.SUBS.delete("u:" + id); return false; }  // пользователь заблокировал бота
      return true;
    };
    if (tournament || airdrop) {
      if (tournament && u.tour && !(await send("🎣 Через 15 минут <b>турнир по рыбалке</b>. Взнос и запись — в планшете, приложение «Рыбалка».", [[{text: "🎣 Выключить турниры", callback_data: "tour"}]]))) return;
      if (airdrop && u.air) await send("📦 Через 15 минут <b>AirDrop</b>. Участвовать может любой: бронежилет до 50 прочности, без транспорта в зоне и без крыш.", [[{text: "📦 Выключить AirDrop", callback_data: "air"}]]);
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
    if (url.pathname === "/online") {
      return new Response(JSON.stringify(await serverOnline()), {headers: {...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60"}});
    }
    if (url.pathname === "/hello") {
      if (req.method === "OPTIONS") return new Response(null, {headers: CORS});
      if (req.method === "POST") return helloHttp(req, env);
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
        {command: "remind", description: "Напоминания: подарок, турниры, AirDrop, налог"},
        {command: "app", description: "Открыть справочник"},
        {command: "online", description: "Сколько игроков на сервере сейчас"},
        {command: "idea", description: "Ошибка или идея по справочнику и боту"},
      ]});
      if (env.OWNER_ID) await tg(env, "setMyCommands", {scope: {type: "chat", chat_id: Number(env.OWNER_ID)}, commands: [
        {command: "remind", description: "Напоминания"}, {command: "app", description: "Открыть справочник"},
        {command: "online", description: "Онлайн сервера"},
        {command: "idea", description: "Ошибка или идея по справочнику и боту"},
        {command: "stats", description: "Статистика (только для тебя)"}, {command: "news", description: "Рассылка всем (только для тебя)"}]});
      const owner = env.OWNER_ID ? await tg(env, "getChat", {chat_id: env.OWNER_ID}) : null;
      const me = await tg(env, "getMe", {});
      return Response.json({webhook: hook.ok, commands: cmds.ok, description: hook.description, bot: me.ok ? "@" + me.result.username : null,
        owner: owner ? (owner.ok ? {ok: true} : {ok: false, error: owner.description}) : "OWNER_ID не задан"});
    }
    return new Response("D9 reminder bot is running");
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, event.cron));
  },
};

/**
 * Richter Pro — Cloudflare Worker v3.0
 *
 * Fixes in v3:
 *   - HTML-Escaping in allen Templates (XSS-Schutz)
 *   - KV Race Condition: individuelle Keys pro Fall statt ein Array
 *   - Lesbare Fallnummern: SCH-2026-0001 Format
 *   - E-Mail Retry (1x bei Fehler)
 *   - Dokument-Bild wird in E-Mail an Silvio eingebettet
 *   - Rate Limiting auf /scan (20/Stunde/IP)
 */

const ALLOWED_ORIGINS = [
  'https://bochmann-dienstleistungen.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'file://',
];

const OEFFNUNGSZEITEN = {
  1: [[8,12],[13,17]],
  2: [[8,12],[13,17]],
  3: [[8,12]],
  4: [[8,12],[13,17]],
  5: [[8,12]],
};

// ── HELPERS ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isGeoeffnet() {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const tag  = now.getDay();
  const h    = now.getHours() + now.getMinutes() / 60;
  const slots = OEFFNUNGSZEITEN[tag];
  if (!slots) return false;
  return slots.some(([s, e]) => h >= s && h < e);
}

function cors(origin) {
  const ok = ALLOWED_ORIGINS.some(o => (origin || '').startsWith(o));
  return {
    'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

// ── FALLNUMMER (lesbar, sequential) ─────────────────────────────────────────
async function nextFallnr(env, prefix) {
  if (!env.RICHTER_KV) return prefix + '-' + Date.now().toString(36).toUpperCase();
  const year = new Date().getFullYear();
  const key  = `counter:${year}:${prefix}`;
  const raw  = await env.RICHTER_KV.get(key).catch(() => null);
  const n    = (raw ? parseInt(raw) : 0) + 1;
  await env.RICHTER_KV.put(key, String(n)).catch(() => {});
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

// ── KV STORAGE (ein Key pro Fall) ───────────────────────────────────────────
async function kvSave(env, entry) {
  if (!env.RICHTER_KV || !entry.fallnr) return;
  await env.RICHTER_KV.put(
    `case:${entry.fallnr}`,
    JSON.stringify(entry),
    { expirationTtl: 60 * 60 * 24 * 365 } // 1 Jahr
  ).catch(() => {});
}

async function kvUpdate(env, fallnr, patch) {
  if (!env.RICHTER_KV) return false;
  const raw = await env.RICHTER_KV.get(`case:${fallnr}`).catch(() => null);
  if (!raw) return false;
  const entry = { ...JSON.parse(raw), ...patch, updatedAt: new Date().toISOString() };
  await env.RICHTER_KV.put(`case:${fallnr}`, JSON.stringify(entry)).catch(() => {});
  return true;
}

async function kvList(env) {
  if (!env.RICHTER_KV) return [];
  try {
    const list = await env.RICHTER_KV.list({ prefix: 'case:', limit: 200 });
    const entries = await Promise.all(
      list.keys.map(k => env.RICHTER_KV.get(k.name).then(v => v ? JSON.parse(v) : null))
    );
    return entries
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch { return []; }
}

// ── E-MAIL MIT RETRY ─────────────────────────────────────────────────────────
async function sendEmail(apiKey, { to, toName, subject, html }, retry = 1) {
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:     'Silvio Richter <noreply@valoris-auftragsstruktur.de>',
          reply_to: 'ga-richter@freenet.de',
          to:       toName ? [`${toName} <${to}>`] : [to],
          subject, html,
        }),
      });
      const data = await res.json();
      if (res.ok) return { ok: true, id: data.id };
      if (attempt < retry) await new Promise(r => setTimeout(r, 800));
      else return { ok: false, error: data };
    } catch(e) {
      if (attempt < retry) await new Promise(r => setTimeout(r, 800));
      else return { ok: false, error: e.message };
    }
  }
}

// ── MAKE.COM / SHEETS ────────────────────────────────────────────────────────
async function sheetsLog(webhookUrl, data) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, timestamp: new Date().toISOString() }),
  }).catch(() => {});
}

// ── WHATSAPP (360dialog) ──────────────────────────────────────────────────────
async function sendWhatsApp(env, to, text) {
  if (!env.WHATSAPP_TOKEN) return { ok: false };
  const res = await fetch('https://waba.360dialog.io/v1/messages', {
    method: 'POST',
    headers: { 'D360-API-KEY': env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  return { ok: res.ok };
}

// ── KI WHATSAPP ───────────────────────────────────────────────────────────────
async function kiWhatsApp(apiKey, nachricht, geoeffnet) {
  if (!apiKey) return standardAntwort(geoeffnet);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `Du bist der freundliche Assistent von Versicherungsmakler Silvio Richter in Zwickau.
Antworte kurz, professionell und hilfreich auf Deutsch. Maximal 3 Sätze.
Büro ist gerade: ${geoeffnet ? 'GEÖFFNET' : 'GESCHLOSSEN'}.
Telefon: 037604/2424 · Adresse: Sportplatzweg 2, 08058 Zwickau
Öffnungszeiten: Mo/Di/Do 8–12 und 13–17 Uhr | Mi/Fr 8–12 Uhr
Schaden melden: https://bochmann-dienstleistungen.github.io/richter-pro/forms/schaden.html
Dokument einreichen: https://bochmann-dienstleistungen.github.io/richter-pro/scanner/`,
        messages: [{ role: 'user', content: nachricht }],
      }),
    });
    const data = await res.json();
    return data?.content?.[0]?.text || standardAntwort(geoeffnet);
  } catch { return standardAntwort(geoeffnet); }
}

function standardAntwort(geoeffnet) {
  return geoeffnet
    ? 'Guten Tag! Versicherungsmakler Richter. Wie kann ich Ihnen helfen? Für dringende Anliegen erreichen Sie uns unter 037604 / 2424.'
    : 'Guten Tag! Unser Büro ist momentan geschlossen. Silvio Richter meldet sich beim nächsten Öffnungstag. Dringende Schadenmeldungen: https://bochmann-dienstleistungen.github.io/richter-pro/forms/schaden.html';
}

// ── HAUPT-HANDLER ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const path   = new URL(request.url).pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // Health
    if (path === '/health' || (path === '/' && request.method === 'GET')) {
      return json({ status: 'ok', worker: 'richter-pro', geoeffnet: isGeoeffnet(), version: '3.0' }, 200, origin);
    }

    // Dashboard — live aus KV
    if (path === '/dashboard' && request.method === 'GET') {
      const cases = await kvList(env);
      return json({ geoeffnet: isGeoeffnet(), timestamp: new Date().toISOString(), cases }, 200, origin);
    }

    // Status-Update
    if (path === '/status' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false }, 400, origin); }
      const { fallnr, status } = body;
      if (!fallnr || !status) return json({ ok: false, error: 'fallnr and status required' }, 400, origin);
      const ok = await kvUpdate(env, fallnr, { status });
      return json({ ok }, 200, origin);
    }

    // Scanner — Vision Proxy mit Rate Limit
    if (path === '/scan' && request.method === 'POST') {
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY not set' }, 500, origin);
      const ip    = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rlKey = `rl:scan:${ip}:${Math.floor(Date.now() / 3600000)}`;
      try {
        const count = parseInt(await env.RICHTER_KV.get(rlKey) || '0');
        if (count >= 20) return json({ error: 'Zu viele Anfragen. Bitte in einer Stunde erneut versuchen.' }, 429, origin);
        await env.RICHTER_KV.put(rlKey, String(count + 1), { expirationTtl: 3600 });
      } catch {}
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }
      body.model      = 'claude-haiku-4-5-20251001';
      body.max_tokens = Math.min(body.max_tokens || 512, 1024);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });
      return json(await res.json(), res.status, origin);
    }

    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404, headers: cors(origin) });
    }

    let body;
    try {
      const ct = request.headers.get('Content-Type') || '';
      body = ct.includes('application/json')
        ? await request.json()
        : Object.fromEntries(new URLSearchParams(await request.text()).entries());
    } catch { return json({ ok: false, error: 'Invalid body' }, 400, origin); }

    const errors = [];

    // ── Lead ──────────────────────────────────────────────────────
    if (path === '/lead' || path === '/') {
      const { name, email, phone, thema, rueckruf, nachricht } = body;
      if (!email || !name) return json({ ok: false, error: 'name and email required' }, 400, origin);
      const fallnr = await nextFallnr(env, 'ANF');

      const [ar, nr] = await Promise.all([
        sendEmail(env.RESEND_API_KEY, {
          to: email, toName: name,
          subject: `Ihre Anfrage bei Versicherungsmakler Richter — Eingang bestätigt`,
          html: tplAutoReply({ name, thema, rueckruf, fallnr }),
        }),
        sendEmail(env.RESEND_API_KEY, {
          to: env.SILVIO_EMAIL || 'ga-richter@freenet.de', toName: 'Silvio Richter',
          subject: `🔔 Neue Anfrage: ${escHtml(name)} — ${escHtml(thema || 'Allgemein')}`,
          html: tplNotification({ name, email, phone, thema, rueckruf, nachricht, fallnr, typ: 'Anfrage' }),
        }),
      ]);
      if (!ar.ok) errors.push({ type: 'auto_reply', error: ar.error });
      if (!nr.ok) errors.push({ type: 'notification', error: nr.error });

      await Promise.all([
        sheetsLog(env.SHEETS_WEBHOOK_URL, { typ: 'Lead', fallnr, name, email, telefon: phone, thema, rueckruf, status: 'Neu' }),
        kvSave(env, { typ: 'Lead', fallnr, name, email, telefon: phone, thema, rueckruf, status: 'Offen', createdAt: new Date().toISOString() }),
      ]);
      return json({ ok: errors.length === 0, fallnr, errors }, 200, origin);
    }

    // ── Schadenmeldung ────────────────────────────────────────────
    if (path === '/schaden') {
      const { fallnr: inputFn, name, email, telefon, versicherung, schaeden, dringlichkeit, datum, beschreibung, rueckruf, fotoAnzahl } = body;
      if (!name) return json({ ok: false, error: 'name required' }, 400, origin);
      const fn        = inputFn || await nextFallnr(env, 'SCH');
      const istNotfall = dringlichkeit === 'notfall';

      const [nr, ar] = await Promise.all([
        sendEmail(env.RESEND_API_KEY, {
          to: env.SILVIO_EMAIL || 'ga-richter@freenet.de', toName: 'Silvio Richter',
          subject: istNotfall ? `🚨 NOTFALL: ${escHtml(name)} — ${escHtml(versicherung)}` : `⚠️ Neue Schadenmeldung: ${escHtml(name)} — ${escHtml(versicherung)}`,
          html: tplSchaden({ fn, name, email, telefon, versicherung, schaeden, dringlichkeit, datum, beschreibung, rueckruf, fotoAnzahl }),
        }),
        email ? sendEmail(env.RESEND_API_KEY, {
          to: email, toName: name,
          subject: `Schadenmeldung ${fn} eingegangen — Versicherungsmakler Richter`,
          html: tplSchadenKunde({ name, fn, versicherung, dringlichkeit }),
        }) : Promise.resolve({ ok: true }),
      ]);
      if (!nr.ok) errors.push({ type: 'notification', error: nr.error });
      if (!ar.ok) errors.push({ type: 'kunde_mail', error: ar.error });

      if (istNotfall && env.WHATSAPP_TOKEN && env.SILVIO_WHATSAPP) {
        sendWhatsApp(env, env.SILVIO_WHATSAPP,
          `🚨 *NOTFALL* Schadenmeldung!\n\nKunde: ${name}\nVersicherung: ${versicherung}\nSchaden: ${schaeden}\nTel: ${telefon || '–'}\nFallnr: ${fn}`
        ).catch(() => {});
      }

      await Promise.all([
        sheetsLog(env.SHEETS_WEBHOOK_URL, { typ: 'Schaden', fallnr: fn, name, email, telefon, versicherung, schaeden, dringlichkeit, datum, rueckruf, status: 'Neu' }),
        kvSave(env, { typ: 'Schaden', fallnr: fn, name, email, telefon, versicherung, schaeden, dringlichkeit, rueckruf, datum, status: 'Offen', createdAt: new Date().toISOString() }),
      ]);
      return json({ ok: errors.length === 0, fallnr: fn, errors }, 200, origin);
    }

    // ── Dokument-Eingang ──────────────────────────────────────────
    if (path === '/dokument') {
      const { fallnr: inputFn, name, email, telefon, docType, anlass, datum, imageB64 } = body;
      if (!name) return json({ ok: false, error: 'name required' }, 400, origin);
      const fn = inputFn || await nextFallnr(env, 'DOK');

      const [nr, ar] = await Promise.all([
        sendEmail(env.RESEND_API_KEY, {
          to: env.SILVIO_EMAIL || 'ga-richter@freenet.de', toName: 'Silvio Richter',
          subject: `📄 Neues Dokument: ${escHtml(name)} — ${escHtml(docType)}`,
          html: tplDokument({ fn, name, email, telefon, docType, anlass, datum, imageB64 }),
        }),
        email ? sendEmail(env.RESEND_API_KEY, {
          to: email, toName: name,
          subject: `Dokument ${fn} eingegangen — Versicherungsmakler Richter`,
          html: tplDokumentKunde({ name, fn, docType }),
        }) : Promise.resolve({ ok: true }),
      ]);
      if (!nr.ok) errors.push({ type: 'notification', error: nr.error });

      await Promise.all([
        sheetsLog(env.SHEETS_WEBHOOK_URL, { typ: 'Dokument', fallnr: fn, name, email, telefon, docType, anlass, datum, status: 'Eingang' }),
        kvSave(env, { typ: 'Dokument', fallnr: fn, name, email, telefon, docType, anlass, datum, status: 'Offen', createdAt: new Date().toISOString() }),
      ]);
      return json({ ok: errors.length === 0, fallnr: fn, errors }, 200, origin);
    }

    // ── WhatsApp Bot ──────────────────────────────────────────────
    if (path === '/whatsapp') {
      try {
        const msg = body?.messages?.[0];
        if (!msg || msg.type !== 'text') return json({ ok: true }, 200, origin);
        const from    = msg.from;
        const text    = msg.text?.body?.trim() || '';
        const geoeffn = isGeoeffnet();
        const antwort = await kiWhatsApp(env.ANTHROPIC_KEY, text, geoeffn);
        await sendWhatsApp(env, from, antwort);
        if (!geoeffn && env.SILVIO_WHATSAPP) {
          sendWhatsApp(env, env.SILVIO_WHATSAPP,
            `💬 *WhatsApp-Anfrage* (Büro geschlossen)\n\nVon: ${from}\n"${text}"\n\nBot hat geantwortet.`
          ).catch(() => {});
        }
      } catch(e) { errors.push({ type: 'whatsapp', error: e.message }); }
      return json({ ok: true }, 200, origin);
    }

    return json({ ok: false, error: 'Unknown endpoint' }, 404, origin);
  }
};

// ── E-MAIL TEMPLATES ──────────────────────────────────────────────────────────

function emailWrap(content) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f0;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f0;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;max-width:600px;width:100%">
<tr><td style="background:#1C2B4A;padding:28px 36px">
  <p style="margin:0;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#B8965A;margin-bottom:4px">Versicherungsmakler</p>
  <h1 style="margin:0;font-size:20px;color:#fff;font-weight:700">Silvio Richter GmbH</h1>
  <p style="margin:3px 0 0;font-size:11px;color:rgba(255,255,255,.5)">Sportplatzweg 2 · 08058 Zwickau · Seit 1990</p>
</td></tr>
<tr><td style="padding:32px 36px">${content}</td></tr>
<tr><td style="background:#f8f6f2;padding:18px 36px;text-align:center">
  <p style="margin:0;font-size:11px;color:#999">Versicherungsmakler Richter GmbH · 037604 / 2424 · <a href="mailto:ga-richter@freenet.de" style="color:#B8965A">ga-richter@freenet.de</a></p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

function row(label, value) {
  if (!value) return '';
  return `<tr><td style="color:#888;font-size:13px;width:130px;padding:8px 0;border-bottom:1px solid #eee;vertical-align:top">${label}</td><td style="color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${value}</td></tr>`;
}

function tplAutoReply({ name, thema, rueckruf, fallnr }) {
  return emailWrap(`
    <p style="margin:0 0 16px;font-size:16px;color:#1C2B4A">Guten Tag ${escHtml(name)},</p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">vielen Dank für Ihre Anfrage. Ich habe sie erhalten und melde mich <strong>persönlich bei Ihnen</strong>.</p>
    ${thema    ? `<p style="margin:0 0 10px;color:#4a5568">Ihr Thema: <strong>${escHtml(thema)}</strong></p>` : ''}
    ${rueckruf ? `<p style="margin:0 0 10px;color:#4a5568">Gewünschter Rückruf: <strong>${escHtml(rueckruf)}</strong></p>` : ''}
    <p style="margin:0 0 10px;color:#4a5568">Ihre Fallnummer: <strong style="font-family:monospace;color:#1C2B4A">${escHtml(fallnr)}</strong></p>
    <p style="margin:20px 0 0;color:#4a5568;line-height:1.7">Freundliche Grüße,<br><strong style="color:#1C2B4A">Silvio Richter</strong></p>
  `);
}

function tplNotification({ name, email, phone, thema, rueckruf, nachricht, fallnr, typ }) {
  return emailWrap(`
    <h2 style="margin:0 0 20px;color:#1C2B4A;font-size:18px">Neue ${escHtml(typ)}: ${escHtml(name)}</h2>
    <table cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse">
      ${row('Fallnummer', `<span style="font-family:monospace;font-weight:700">${escHtml(fallnr)}</span>`)}
      ${row('Name', `<strong>${escHtml(name)}</strong>`)}
      ${email ? row('E-Mail', `<a href="mailto:${escHtml(email)}" style="color:#B8965A">${escHtml(email)}</a>`) : ''}
      ${phone ? row('Telefon', `<a href="tel:${escHtml(phone)}" style="color:#1C2B4A;font-weight:600">${escHtml(phone)}</a>`) : ''}
      ${row('Thema', escHtml(thema))}
      ${row('Rückruf', `<strong>${escHtml(rueckruf)}</strong>`)}
      ${row('Nachricht', escHtml(nachricht))}
    </table>
    <div style="margin-top:20px">
      <a href="mailto:${escHtml(email)}" style="display:inline-block;background:#1C2B4A;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600;margin-right:8px">Antworten</a>
      ${phone ? `<a href="tel:${escHtml(phone)}" style="display:inline-block;background:#B8965A;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600">Anrufen</a>` : ''}
    </div>
  `);
}

function tplSchaden({ fn, name, email, telefon, versicherung, schaeden, dringlichkeit, datum, beschreibung, rueckruf, fotoAnzahl }) {
  const badge = dringlichkeit === 'notfall' ? '🚨 NOTFALL' : dringlichkeit === 'urgent' ? '⚠️ DRINGEND' : '🟢 Normal';
  return emailWrap(`
    <h2 style="margin:0 0 6px;color:#1C2B4A;font-size:18px">Neue Schadenmeldung</h2>
    <p style="margin:0 0 20px;font-size:22px;font-weight:800">${badge}</p>
    <table cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse">
      ${row('Fallnummer', `<span style="font-family:monospace;font-weight:700">${escHtml(fn)}</span>`)}
      ${row('Kunde', `<strong>${escHtml(name)}</strong>`)}
      ${telefon ? row('Telefon', `<a href="tel:${escHtml(telefon)}" style="color:#1C2B4A;font-weight:700;font-size:16px">${escHtml(telefon)}</a>`) : ''}
      ${email   ? row('E-Mail', `<a href="mailto:${escHtml(email)}" style="color:#B8965A">${escHtml(email)}</a>`) : ''}
      ${row('Versicherung', `<strong>${escHtml(versicherung)}</strong>`)}
      ${row('Schaden', escHtml(schaeden))}
      ${row('Datum', escHtml(datum))}
      ${row('Rückruf', `<strong>${escHtml(rueckruf)}</strong>`)}
      ${fotoAnzahl > 0 ? row('Fotos', `<span style="color:#27AE60;font-weight:600">${fotoAnzahl} Foto(s) eingereicht</span>`) : ''}
      ${row('Beschreibung', escHtml(beschreibung))}
    </table>
    ${telefon ? `<div style="margin-top:20px"><a href="tel:${escHtml(telefon)}" style="display:inline-block;background:#C0392B;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:15px;font-weight:700">📞 Jetzt zurückrufen</a></div>` : ''}
  `);
}

function tplSchadenKunde({ name, fn, versicherung, dringlichkeit }) {
  const hinweis = dringlichkeit === 'notfall'
    ? 'Da Sie einen <strong>Notfall</strong> gemeldet haben, wird Silvio Richter Sie so schnell wie möglich kontaktieren.'
    : dringlichkeit === 'urgent'
    ? 'Ihre dringende Schadenmeldung wurde erfasst. Sie erhalten noch heute eine Rückmeldung.'
    : 'Ihre Schadenmeldung wurde erfasst. Sie erhalten innerhalb von 48 Stunden eine Rückmeldung.';
  return emailWrap(`
    <p style="margin:0 0 16px;font-size:16px;color:#1C2B4A">Guten Tag ${escHtml(name)},</p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">Ihre Schadenmeldung für <strong>${escHtml(versicherung)}</strong> ist eingegangen.</p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">${hinweis}</p>
    <p style="margin:0 0 14px;color:#4a5568">Fallnummer: <strong style="font-family:monospace;font-size:16px;color:#1C2B4A">${escHtml(fn)}</strong></p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">Weitere Dokumente einreichen: <a href="https://bochmann-dienstleistungen.github.io/richter-pro/scanner/" style="color:#B8965A;font-weight:600">Hier klicken →</a></p>
    <p style="margin:20px 0 0;color:#4a5568">Freundliche Grüße,<br><strong style="color:#1C2B4A">Silvio Richter</strong></p>
  `);
}

function tplDokument({ fn, name, email, telefon, docType, anlass, datum, imageB64 }) {
  const bildBlock = imageB64
    ? `<tr><td colspan="2" style="padding:12px 0"><img src="data:image/jpeg;base64,${imageB64}" style="max-width:100%;border-radius:8px;border:1px solid #eee" alt="Dokument"></td></tr>`
    : '';
  return emailWrap(`
    <h2 style="margin:0 0 20px;color:#1C2B4A;font-size:18px">📄 Neues Dokument eingegangen</h2>
    <table cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse">
      ${row('Fallnummer', `<span style="font-family:monospace;font-weight:700">${escHtml(fn)}</span>`)}
      ${row('Kunde', `<strong>${escHtml(name)}</strong>`)}
      ${email   ? row('E-Mail', `<a href="mailto:${escHtml(email)}" style="color:#B8965A">${escHtml(email)}</a>`) : ''}
      ${telefon ? row('Telefon', escHtml(telefon)) : ''}
      ${row('Dokumenttyp', `<strong>${escHtml(docType)}</strong>`)}
      ${row('Anlass', escHtml(anlass))}
      ${row('Datum', escHtml(datum))}
      ${bildBlock}
    </table>
  `);
}

function tplDokumentKunde({ name, fn, docType }) {
  return emailWrap(`
    <p style="margin:0 0 16px;font-size:16px;color:#1C2B4A">Guten Tag ${escHtml(name)},</p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">Ihr Dokument (<strong>${escHtml(docType)}</strong>) wurde sicher übermittelt und wird zeitnah bearbeitet.</p>
    <p style="margin:0 0 14px;color:#4a5568">Referenznummer: <strong style="font-family:monospace;font-size:16px;color:#1C2B4A">${escHtml(fn)}</strong></p>
    <p style="margin:20px 0 0;color:#4a5568">Freundliche Grüße,<br><strong style="color:#1C2B4A">Silvio Richter</strong></p>
  `);
}

/**
 * Richter Pro — Cloudflare Worker
 * Zentrale API für alle Automation-Module
 *
 * Endpoints:
 *   GET  /health          → Status-Check
 *   POST /lead            → Website-Anfrage (Formspree Webhook)
 *   POST /schaden         → Digitale Schadenmeldung
 *   POST /dokument        → Dokument-Upload + KI-Analyse
 *   POST /scan            → Direkte Anthropic Vision API (für Scanner)
 *   POST /whatsapp        → WhatsApp Bot (360dialog Webhook)
 *   GET  /dashboard       → Dashboard-Daten (offene Fälle)
 *
 * Secrets (wrangler secret put):
 *   RESEND_API_KEY        → E-Mail Versand
 *   ANTHROPIC_KEY         → KI-Analyse
 *   WHATSAPP_TOKEN        → 360dialog API Token
 *   WHATSAPP_NUMBER_ID    → 360dialog Nummer-ID
 *   SHEETS_WEBHOOK_URL    → Make.com Webhook
 *   SILVIO_EMAIL          → ga-richter@freenet.de
 *   SILVIO_WHATSAPP       → Silvioe WhatsApp-Nummer (49...)
 */

const ALLOWED_ORIGINS = [
  'https://bochmann-dienstleistungen.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'file://',
];

const OEFFNUNGSZEITEN = {
  1: [[8,12],[13,17]],  // Mo
  2: [[8,12],[13,17]],  // Di
  3: [[8,12]],          // Mi
  4: [[8,12],[13,17]],  // Do
  5: [[8,12]],          // Fr
};

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

// ── HAUPT-HANDLER ──────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const path   = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // ── Health Check ────────────────────────────────────────────
    if (path === '/health' || (path === '/' && request.method === 'GET')) {
      return json({
        status:    'ok',
        worker:    'richter-pro',
        geoeffnet: isGeoeffnet(),
        version:   '2.0',
      }, 200, origin);
    }

    // ── Dashboard-Daten (live aus KV) ───────────────────────────
    if (path === '/dashboard' && request.method === 'GET') {
      let cases = [];
      try {
        const raw = await env.RICHTER_KV.get('cases');
        cases = raw ? JSON.parse(raw) : [];
      } catch {}
      return json({ geoeffnet: isGeoeffnet(), timestamp: new Date().toISOString(), cases }, 200, origin);
    }

    // ── Status-Update ────────────────────────────────────────────
    if (path === '/status' && request.method === 'POST') {
      let body2;
      try { body2 = await request.json(); } catch { return json({ ok: false }, 400, origin); }
      const { fallnr, status } = body2;
      if (!fallnr || !status) return json({ ok: false, error: 'fallnr and status required' }, 400, origin);
      try {
        const raw = await env.RICHTER_KV.get('cases');
        const cases = raw ? JSON.parse(raw) : [];
        const idx = cases.findIndex(c => c.fallnr === fallnr);
        if (idx !== -1) { cases[idx].status = status; cases[idx].updatedAt = new Date().toISOString(); }
        await env.RICHTER_KV.put('cases', JSON.stringify(cases));
      } catch(e) { return json({ ok: false, error: e.message }, 500, origin); }
      return json({ ok: true }, 200, origin);
    }

    // ── Anthropic Vision Proxy (für Scanner) ────────────────────
    if (path === '/scan' && request.method === 'POST') {
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY not set' }, 500, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }
      body.model      = 'claude-haiku-4-5-20251001';
      body.max_tokens = Math.min(body.max_tokens || 512, 1024);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body:    JSON.stringify(body),
      });
      return json(await res.json(), res.status, origin);
    }

    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404, headers: cors(origin) });
    }

    // Body parsen (JSON oder Formspree URL-encoded)
    let body;
    try {
      const ct = request.headers.get('Content-Type') || '';
      if (ct.includes('application/json')) {
        body = await request.json();
      } else {
        const text = await request.text();
        const params = new URLSearchParams(text);
        body = Object.fromEntries(params.entries());
      }
    } catch { return json({ ok: false, error: 'Invalid body' }, 400, origin); }

    const errors = [];

    // ── Neue Website-Anfrage (Lead) ─────────────────────────────
    if (path === '/lead' || path === '/') {
      const { name, email, phone, thema, rueckruf, nachricht } = body;
      if (!email || !name) return json({ ok: false, error: 'name and email required' }, 400, origin);

      const fallnr = 'ANF-' + Date.now().toString(36).toUpperCase();

      // Auto-Reply an Kunden
      const ar = await sendEmail(env.RESEND_API_KEY, {
        to: email, toName: name,
        subject: 'Ihre Anfrage bei Versicherungsmakler Richter — Eingang bestätigt',
        html: tplAutoReply({ name, thema, rueckruf, fallnr }),
      });
      if (!ar.ok) errors.push({ type: 'auto_reply', error: ar.error });

      // Benachrichtigung Silvio
      const nr = await sendEmail(env.RESEND_API_KEY, {
        to: env.SILVIO_EMAIL || 'ga-richter@freenet.de', toName: 'Silvio Richter',
        subject: `🔔 Neue Anfrage: ${name} — ${thema || 'Allgemein'}`,
        html: tplNotification({ name, email, phone, thema, rueckruf, nachricht, fallnr, typ: 'Anfrage' }),
      });
      if (!nr.ok) errors.push({ type: 'notification', error: nr.error });

      // Sheets/CRM
      await sheetsLog(env.SHEETS_WEBHOOK_URL, { typ: 'Lead', fallnr, name, email, telefon: phone, thema, rueckruf, nachricht, status: 'Neu', quelle: 'Website' }).catch(e => errors.push({ type: 'sheets', error: e.message }));
      await kvSave(env, { typ: 'Lead', fallnr, name, email, telefon: phone, thema, rueckruf, status: 'Offen', createdAt: new Date().toISOString() });

      return json({ ok: errors.length === 0, fallnr, errors }, 200, origin);
    }

    // ── Schadenmeldung ──────────────────────────────────────────
    if (path === '/schaden') {
      const { fallnr, name, email, telefon, versicherung, schaeden, dringlichkeit, datum, beschreibung, rueckruf, fotoAnzahl } = body;
      if (!name) return json({ ok: false, error: 'name required' }, 400, origin);

      const fn = fallnr || ('SCH-' + Date.now().toString(36).toUpperCase());
      const istNotfall = dringlichkeit === 'notfall';
      const subject = istNotfall
        ? `🚨 NOTFALL Schadenmeldung: ${name} — ${versicherung}`
        : `⚠️ Neue Schadenmeldung: ${name} — ${versicherung}`;

      // Benachrichtigung Silvio (immer, auch nachts)
      if (email || env.SILVIO_EMAIL) {
        const nr = await sendEmail(env.RESEND_API_KEY, {
          to: env.SILVIO_EMAIL || 'ga-richter@freenet.de', toName: 'Silvio Richter',
          subject,
          html: tplSchaden({ fn, name, email, telefon, versicherung, schaeden, dringlichkeit, datum, beschreibung, rueckruf, fotoAnzahl }),
        });
        if (!nr.ok) errors.push({ type: 'notification', error: nr.error });
      }

      // Bestätigung an Kunden
      if (email) {
        const ar = await sendEmail(env.RESEND_API_KEY, {
          to: email, toName: name,
          subject: `Schadenmeldung ${fn} eingegangen — Versicherungsmakler Richter`,
          html: tplSchadenKunde({ name, fn, versicherung, dringlichkeit }),
        });
        if (!ar.ok) errors.push({ type: 'kunde_mail', error: ar.error });
      }

      // WhatsApp an Silvio bei Notfall
      if (istNotfall && env.WHATSAPP_TOKEN && env.SILVIO_WHATSAPP) {
        await sendWhatsApp(env, env.SILVIO_WHATSAPP,
          `🚨 *NOTFALL* Schadenmeldung eingegangen!\n\nKunde: ${name}\nVersicherung: ${versicherung}\nSchaden: ${schaeden}\nTelefon: ${telefon || '–'}\n\nFallnummer: ${fn}`
        ).catch(() => {});
      }

      await sheetsLog(env.SHEETS_WEBHOOK_URL, { typ: 'Schaden', fallnr: fn, name, email, telefon, versicherung, schaeden, dringlichkeit, datum, status: 'Neu' }).catch(() => {});
      await kvSave(env, { typ: 'Schaden', fallnr: fn, name, email, telefon, versicherung, schaeden, dringlichkeit, rueckruf, datum, status: 'Offen', createdAt: new Date().toISOString() });

      return json({ ok: errors.length === 0, fallnr: fn, errors }, 200, origin);
    }

    // ── Dokument-Eingang ────────────────────────────────────────
    if (path === '/dokument') {
      const { fallnr, name, email, telefon, docType, anlass, datum } = body;
      if (!name) return json({ ok: false, error: 'name required' }, 400, origin);

      const fn = fallnr || ('DOK-' + Date.now().toString(36).toUpperCase());

      // Benachrichtigung Silvio
      const nr = await sendEmail(env.RESEND_API_KEY, {
        to: env.SILVIO_EMAIL || 'ga-richter@freenet.de', toName: 'Silvio Richter',
        subject: `📄 Neues Dokument: ${name} — ${docType}`,
        html: tplDokument({ fn, name, email, telefon, docType, anlass, datum }),
      });
      if (!nr.ok) errors.push({ type: 'notification', error: nr.error });

      // Bestätigung Kunde
      if (email) {
        await sendEmail(env.RESEND_API_KEY, {
          to: email, toName: name,
          subject: `Dokument ${fn} eingegangen — Versicherungsmakler Richter`,
          html: tplDokumentKunde({ name, fn, docType }),
        }).catch(() => {});
      }

      await sheetsLog(env.SHEETS_WEBHOOK_URL, { typ: 'Dokument', fallnr: fn, name, email, telefon, docType, anlass, datum, status: 'Eingang' }).catch(() => {});
      await kvSave(env, { typ: 'Dokument', fallnr: fn, name, email, telefon, docType, anlass, datum, status: 'Offen', createdAt: new Date().toISOString() });

      return json({ ok: errors.length === 0, fallnr: fn, errors }, 200, origin);
    }

    // ── WhatsApp Bot (360dialog Webhook) ────────────────────────
    if (path === '/whatsapp') {
      try {
        const msg = body?.messages?.[0];
        if (!msg || msg.type !== 'text') return json({ ok: true }, 200, origin);

        const from    = msg.from;
        const text    = msg.text?.body?.trim() || '';
        const geoeffn = isGeoeffnet();

        const antwort = await kiWhatsApp(env.ANTHROPIC_KEY, text, geoeffn);
        await sendWhatsApp(env, from, antwort);

        // Silvio informieren wenn außerhalb Öffnungszeiten
        if (!geoeffn && env.SILVIO_WHATSAPP) {
          await sendWhatsApp(env, env.SILVIO_WHATSAPP,
            `💬 *Neue WhatsApp-Anfrage* (außerhalb Öffnungszeiten)\n\nVon: ${from}\nNachricht: "${text}"\n\nBot hat geantwortet.`
          ).catch(() => {});
        }
      } catch(e) { errors.push({ type: 'whatsapp', error: e.message }); }

      return json({ ok: true }, 200, origin);
    }

    return json({ ok: false, error: 'Unknown endpoint' }, 404, origin);
  }
};

// ── KI WHATSAPP ANTWORT ──────────────────────────────────────────────────
async function kiWhatsApp(apiKey, nachricht, geoeffnet) {
  if (!apiKey) return standardAntwort(geoeffnet);

  const systemPrompt = `Du bist der freundliche Assistent von Versicherungsmakler Silvio Richter in Zwickau.
Antworte kurz, professionell und hilfreich auf Deutsch. Maximal 3 Sätze.
Büro ist gerade: ${geoeffnet ? 'GEÖFFNET' : 'GESCHLOSSEN'}.

Kontaktdaten:
- Telefon: 037604 / 2424
- Adresse: Sportplatzweg 2, 08058 Zwickau
- Öffnungszeiten: Mo/Di/Do 8–12 und 13–17 Uhr | Mi/Fr 8–12 Uhr

Wenn der Kunde eine Schadenmeldung hat: Link zum Formular schicken: https://bochmann-dienstleistungen.github.io/richter-pro/forms/schaden.html
Wenn der Kunde Dokumente einreichen will: https://bochmann-dienstleistungen.github.io/richter-pro/scanner/
Wenn das Büro geschlossen ist: Erkläre wann Silvio sich meldet und biete die Online-Links an.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: nachricht }],
      }),
    });
    const data = await res.json();
    return data?.content?.[0]?.text || standardAntwort(geoeffnet);
  } catch {
    return standardAntwort(geoeffnet);
  }
}

function standardAntwort(geoeffnet) {
  if (geoeffnet) {
    return 'Guten Tag! Versicherungsmakler Richter. Wie kann ich Ihnen helfen? Für dringende Anliegen erreichen Sie uns unter 037604 / 2424.';
  }
  return 'Guten Tag! Unser Büro ist momentan geschlossen. Silvio Richter meldet sich beim nächsten Öffnungstag bei Ihnen. Dringende Schadenmeldungen: https://bochmann-dienstleistungen.github.io/richter-pro/forms/schaden.html';
}

// ── WHATSAPP SENDEN (360dialog) ──────────────────────────────────────────
async function sendWhatsApp(env, to, text) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_NUMBER_ID) return { ok: false };
  const res = await fetch(`https://waba.360dialog.io/v1/messages`, {
    method: 'POST',
    headers: { 'D360-API-KEY': env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  return { ok: res.ok };
}

// ── RESEND E-MAIL ────────────────────────────────────────────────────────
async function sendEmail(apiKey, { to, toName, subject, html }) {
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:     'Versicherungsmakler Richter <noreply@valoris-auftragsstruktur.de>',
        reply_to: 'ga-richter@freenet.de',
        to:       toName ? [`${toName} <${to}>`] : [to],
        subject, html,
      }),
    });
    const data = await res.json();
    return res.ok ? { ok: true, id: data.id } : { ok: false, error: data };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── CLOUDFLARE KV STORAGE ────────────────────────────────────────────────
async function kvSave(env, entry) {
  if (!env.RICHTER_KV) return;
  try {
    const raw = await env.RICHTER_KV.get('cases');
    const cases = raw ? JSON.parse(raw) : [];
    cases.unshift(entry);
    if (cases.length > 200) cases.length = 200;
    await env.RICHTER_KV.put('cases', JSON.stringify(cases));
  } catch {}
}

// ── MAKE.COM / GOOGLE SHEETS ─────────────────────────────────────────────
async function sheetsLog(webhookUrl, data) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, timestamp: new Date().toISOString() }),
  });
}

// ── E-MAIL TEMPLATES ─────────────────────────────────────────────────────

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
  <p style="margin:0;font-size:11px;color:#999">
    Versicherungsmakler Richter GmbH · 037604 / 2424 · <a href="mailto:ga-richter@freenet.de" style="color:#B8965A">ga-richter@freenet.de</a>
  </p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

function tplAutoReply({ name, thema, rueckruf, fallnr }) {
  return emailWrap(`
    <p style="margin:0 0 16px;font-size:16px;color:#1C2B4A">Guten Tag ${name},</p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">vielen Dank für Ihre Anfrage. Ich habe sie erhalten und melde mich <strong>persönlich bei Ihnen</strong>.</p>
    ${thema   ? `<p style="margin:0 0 10px;color:#4a5568">Ihr Thema: <strong>${thema}</strong></p>` : ''}
    ${rueckruf? `<p style="margin:0 0 10px;color:#4a5568">Gewünschter Rückruf: <strong>${rueckruf}</strong></p>` : ''}
    <p style="margin:0 0 10px;color:#4a5568">Ihre Fallnummer: <strong style="font-family:monospace;color:#1C2B4A">${fallnr}</strong></p>
    <p style="margin:20px 0 0;color:#4a5568;line-height:1.7">Freundliche Grüße,<br><strong style="color:#1C2B4A">Silvio Richter</strong></p>
  `);
}

function tplNotification({ name, email, phone, thema, rueckruf, nachricht, fallnr, typ }) {
  return emailWrap(`
    <h2 style="margin:0 0 20px;color:#1C2B4A;font-size:18px">Neue ${typ}: ${name}</h2>
    <table cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse">
      <tr><td style="color:#888;font-size:13px;width:120px;padding:8px 0;border-bottom:1px solid #eee">Fallnummer</td><td style="font-family:monospace;font-weight:700;color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${fallnr}</td></tr>
      <tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Name</td><td style="font-weight:600;color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${name}</td></tr>
      <tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">E-Mail</td><td style="padding:8px 0;border-bottom:1px solid #eee"><a href="mailto:${email}" style="color:#B8965A">${email}</a></td></tr>
      ${phone    ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Telefon</td><td style="padding:8px 0;border-bottom:1px solid #eee"><a href="tel:${phone}" style="color:#1C2B4A;font-weight:600">${phone}</a></td></tr>` : ''}
      ${thema    ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Thema</td><td style="color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${thema}</td></tr>` : ''}
      ${rueckruf ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Rückruf</td><td style="color:#1C2B4A;font-weight:600;padding:8px 0;border-bottom:1px solid #eee">${rueckruf}</td></tr>` : ''}
      ${nachricht? `<tr><td style="color:#888;font-size:13px;padding:8px 0;vertical-align:top">Nachricht</td><td style="color:#1C2B4A;padding:8px 0">${nachricht}</td></tr>` : ''}
    </table>
    <div style="margin-top:20px;display:flex;gap:10px">
      <a href="mailto:${email}" style="display:inline-block;background:#1C2B4A;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600;margin-right:8px">Antworten</a>
      ${phone ? `<a href="tel:${phone}" style="display:inline-block;background:#B8965A;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600">Anrufen</a>` : ''}
    </div>
  `);
}

function tplSchaden({ fn, name, email, telefon, versicherung, schaeden, dringlichkeit, datum, beschreibung, rueckruf, fotoAnzahl }) {
  const dringBadge = dringlichkeit === 'notfall' ? '🚨 NOTFALL' : dringlichkeit === 'urgent' ? '⚠️ DRINGEND' : '🟢 Normal';
  return emailWrap(`
    <h2 style="margin:0 0 6px;color:#1C2B4A;font-size:18px">Neue Schadenmeldung</h2>
    <p style="margin:0 0 20px;font-size:22px;font-weight:800">${dringBadge}</p>
    <table cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse">
      <tr><td style="color:#888;font-size:13px;width:130px;padding:8px 0;border-bottom:1px solid #eee">Fallnummer</td><td style="font-family:monospace;font-weight:700;color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${fn}</td></tr>
      <tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Kunde</td><td style="font-weight:600;color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${name}</td></tr>
      ${telefon ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Telefon</td><td style="padding:8px 0;border-bottom:1px solid #eee"><a href="tel:${telefon}" style="color:#1C2B4A;font-weight:700;font-size:16px">${telefon}</a></td></tr>` : ''}
      ${email   ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">E-Mail</td><td style="padding:8px 0;border-bottom:1px solid #eee"><a href="mailto:${email}" style="color:#B8965A">${email}</a></td></tr>` : ''}
      <tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Versicherung</td><td style="color:#1C2B4A;font-weight:600;padding:8px 0;border-bottom:1px solid #eee">${versicherung}</td></tr>
      <tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Schaden</td><td style="color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${schaeden}</td></tr>
      ${datum    ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Datum</td><td style="color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${datum}</td></tr>` : ''}
      ${rueckruf ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Rückruf</td><td style="color:#1C2B4A;font-weight:600;padding:8px 0;border-bottom:1px solid #eee">${rueckruf}</td></tr>` : ''}
      ${fotoAnzahl>0 ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Fotos</td><td style="color:#27AE60;font-weight:600;padding:8px 0;border-bottom:1px solid #eee">${fotoAnzahl} Foto(s) eingereicht</td></tr>` : ''}
      ${beschreibung ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;vertical-align:top">Beschreibung</td><td style="color:#1C2B4A;padding:8px 0;line-height:1.6">${beschreibung}</td></tr>` : ''}
    </table>
    ${telefon ? `<div style="margin-top:20px"><a href="tel:${telefon}" style="display:inline-block;background:#C0392B;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:15px;font-weight:700">📞 Jetzt zurückrufen</a></div>` : ''}
  `);
}

function tplSchadenKunde({ name, fn, versicherung, dringlichkeit }) {
  const hinweis = dringlichkeit === 'notfall'
    ? 'Da Sie einen <strong>Notfall</strong> gemeldet haben, wird Silvio Richter Sie so schnell wie möglich kontaktieren.'
    : dringlichkeit === 'urgent'
    ? 'Ihre dringende Schadenmeldung wurde erfasst. Sie erhalten noch heute eine Rückmeldung.'
    : 'Ihre Schadenmeldung wurde erfasst. Sie erhalten innerhalb von 48 Stunden eine Rückmeldung.';
  return emailWrap(`
    <p style="margin:0 0 16px;font-size:16px;color:#1C2B4A">Guten Tag ${name},</p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">Ihre Schadenmeldung für <strong>${versicherung}</strong> ist eingegangen.</p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">${hinweis}</p>
    <p style="margin:0 0 14px;color:#4a5568">Ihre Fallnummer: <strong style="font-family:monospace;font-size:16px;color:#1C2B4A">${fn}</strong></p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">Haben Sie weitere Dokumente (Fotos, Rechnungen)? <a href="https://bochmann-dienstleistungen.github.io/richter-pro/scanner/" style="color:#B8965A;font-weight:600">Hier einreichen →</a></p>
    <p style="margin:20px 0 0;color:#4a5568">Freundliche Grüße,<br><strong style="color:#1C2B4A">Silvio Richter</strong></p>
  `);
}

function tplDokument({ fn, name, email, telefon, docType, anlass, datum }) {
  return emailWrap(`
    <h2 style="margin:0 0 20px;color:#1C2B4A;font-size:18px">📄 Neues Dokument eingegangen</h2>
    <table cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse">
      <tr><td style="color:#888;font-size:13px;width:120px;padding:8px 0;border-bottom:1px solid #eee">Fallnummer</td><td style="font-family:monospace;font-weight:700;color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${fn}</td></tr>
      <tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Kunde</td><td style="font-weight:600;color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${name}</td></tr>
      ${email   ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">E-Mail</td><td style="padding:8px 0;border-bottom:1px solid #eee"><a href="mailto:${email}" style="color:#B8965A">${email}</a></td></tr>` : ''}
      ${telefon ? `<tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Telefon</td><td style="padding:8px 0;border-bottom:1px solid #eee">${telefon}</td></tr>` : ''}
      <tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Dokumenttyp</td><td style="color:#1C2B4A;font-weight:600;padding:8px 0;border-bottom:1px solid #eee">${docType}</td></tr>
      <tr><td style="color:#888;font-size:13px;padding:8px 0;border-bottom:1px solid #eee">Anlass</td><td style="color:#1C2B4A;padding:8px 0;border-bottom:1px solid #eee">${anlass}</td></tr>
      ${datum   ? `<tr><td style="color:#888;font-size:13px;padding:8px 0">Eingangsdatum</td><td style="color:#1C2B4A;padding:8px 0">${datum}</td></tr>` : ''}
    </table>
  `);
}

function tplDokumentKunde({ name, fn, docType }) {
  return emailWrap(`
    <p style="margin:0 0 16px;font-size:16px;color:#1C2B4A">Guten Tag ${name},</p>
    <p style="margin:0 0 14px;color:#4a5568;line-height:1.7">Ihr Dokument (<strong>${docType}</strong>) wurde sicher übermittelt und wird zeitnah bearbeitet.</p>
    <p style="margin:0 0 14px;color:#4a5568">Ihre Referenznummer: <strong style="font-family:monospace;font-size:16px;color:#1C2B4A">${fn}</strong></p>
    <p style="margin:20px 0 0;color:#4a5568">Freundliche Grüße,<br><strong style="color:#1C2B4A">Silvio Richter</strong></p>
  `);
}

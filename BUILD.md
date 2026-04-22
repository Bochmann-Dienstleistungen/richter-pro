# Silvio Richter — KI-Automation Pro Build
# Datum: 22.04.2026 (morgen)
# Status: BEREIT ZUM BUILD

---

## Was wir morgen bauen

### 1. MITARBEITER-DASHBOARD (dashboard/index.html)
Für die ukrainische Sprechhilfe — kein Freitext, nur Buttons und Ampeln.

DESIGN:
- Navy #1C2B4A + Gold #B8965A (Richter-Branding)
- Mobile-first, funktioniert auf Tablet
- Schriftgröße groß, Icons statt Text wo möglich
- Sprache: Deutsch, aber ultra-simpel (A2-Niveau)

FEATURES:
- Ampel-Übersicht: 🔴 Dringend / 🟡 Offen / 🟢 Erledigt
- Neue Schadenmeldung aufnehmen → 1 Button, Formular erscheint
- Neuen Kunden anlegen → 1 Button
- Dokument einem Kunden zuweisen → 1 Button
- Rückruf eintragen → 1 Button
- Keine Freitext-Felder → alles Dropdowns / vorausgefüllte Templates
- Live-Counter: "3 offene Fälle heute"
- Öffnungszeiten-Status: "Büro GEÖFFNET / GESCHLOSSEN" (automatisch)

---

### 2. DOKUMENT-SCANNER (scanner/index.html)
Für Kunden — mobil und Desktop, so einfach wie WhatsApp-Foto schicken.

FEATURES:
- Kamera-Button (mobil) + Datei-Upload (Desktop)
- HEIC → JPEG Konvertierung (iPhone-Fix, bereits gebaut)
- KI erkennt automatisch Dokumenttyp:
  → Personalausweis / Police / Rechnung / Schadensfoto /
     KFZ-Schein / Kündigung / Sonstiges
- Felder werden automatisch ausgefüllt (Name, Datum, Versicherung)
- Kunde gibt nur noch E-Mail ein → absenden
- Bestätigung: "Ihr Dokument wurde sicher übermittelt ✓"
- Cloudflare Worker speichert alles → Dashboard bekommt Alert

DESIGN:
- Gleiche Farben wie Richter-Website
- 3 Schritte sichtbar: 📷 Foto → 🔍 Prüfen → ✅ Senden
- Kein Login nötig (Hürde zu hoch)

---

### 3. SCHADENMELDUNG DIGITAL (forms/schaden.html)
Für Kunden — ersetzt den Anruf bei Silvio.

FELDER:
- Name + Telefon + E-Mail
- Versicherungsart: [KFZ / Hausrat / Haftpflicht / Leben / Sonstiges]
- Schadensdatum (Datepicker)
- Was ist passiert? (max. 3 Fehlbeschreibungen als Checkboxen + Freitext optional)
- Fotos hinzufügen (bis 5 Bilder, KI analysiert automatisch)
- Dringlichkeit: [Normal / Dringend / Notfall]

NACH ABSENDEN:
- Kunde: sofortige Bestätigungs-E-Mail mit Fallnummer
- Silvio: strukturierte Alert-E-Mail + Dashboard-Eintrag
- Außerhalb Öffnungszeiten: WhatsApp-Bot übernimmt

---

### 4. WHATSAPP KI-BOT (worker/whatsapp.js)
Antwortet 24/7 — auch wenn Silvio schläft oder beim Hausbesuch ist.

KANN:
- Häufige Fragen beantworten (Öffnungszeiten, Adresse, Leistungen)
- Schadenmeldung entgegennehmen (strukturiert per Chat)
- Termin vorschlagen (Kalender-Link schicken)
- Dokument-Scanner-Link schicken
- Außerhalb Öffnungszeiten: "Ich leite Ihre Anfrage weiter. Silvio meldet sich morgen um [X] Uhr."
- Dringende Fälle: sofort SMS/WhatsApp an Silvio

WISSEN (im Prompt):
- Name: Silvio Richter, Versicherungsmakler
- Adresse: Sportplatzweg 2, 08058 Zwickau
- Tel: 037604 / 2424
- Öffnungszeiten: [morgen bei Silvio erfragen]
- Leistungen: KFZ, Hausrat, Haftpflicht, Leben, Berufsunfähigkeit, etc.
- Ton: professionell, warm, kurze Sätze

---

### 5. CLOUDFLARE WORKER UPDATE (worker/index.js)
Zentrale API — alle Komponenten laufen hier durch.

NEUE ENDPOINTS:
- POST /schaden       → Schadenmeldung verarbeiten
- POST /dokument      → Dokument-Upload + KI-Analyse
- POST /whatsapp      → WhatsApp Webhook (360dialog)
- GET  /dashboard     → Dashboard-Daten (offene Fälle, etc.)
- POST /lead          → Neue Website-Anfrage (bereits vorhanden)

SECRETS NEEDED:
- RESEND_API_KEY      ✅ bereits gesetzt
- ANTHROPIC_KEY       → morgen neu setzen (nach wrangler login)
- WHATSAPP_TOKEN      → nach 360dialog Setup
- SHEETS_WEBHOOK_URL  → nach Make.com Setup

---

## Externe Setups (brauchst DU — 30 Min morgen)

1. RESEND DOMAIN
   → resend.com/domains → "Add Domain"
   → Domain: valoris-auftragsstruktur.de eingeben
   → 3 DNS-Einträge bei deinem Provider eintragen
   → Brauche: Zugang zu DNS deiner Domain

2. WRANGLER LOGIN (OAuth abgelaufen)
   → export PATH="$HOME/.npm-global/bin:$PATH" && wrangler login
   → Browser öffnet sich → einloggen

3. 360DIALOG WHATSAPP (10 Min)
   → 360dialog.com → Account erstellen
   → WhatsApp Business Number: Silvios Nummer eintragen
   → API Key bekommen → in Worker als Secret setzen

4. MAKE.COM (5 Min)
   → make.com → kostenloses Konto
   → Google Sheets Verbindung
   → Webhook-URL in Worker eintragen

---

## Dateistruktur nach Build

richter-pro/
├── dashboard/
│   └── index.html          ← Mitarbeiter-Dashboard
├── scanner/
│   └── index.html          ← Dokument-Scanner (Kunden)
├── forms/
│   └── schaden.html        ← Schadenmeldung (Kunden)
├── worker/
│   ├── index.js            ← Cloudflare Worker (komplett neu)
│   └── wrangler.toml
└── BUILD.md

Live-URLs nach Deploy:
- Dashboard:     bochmann-dienstleistungen.github.io/richter-pro/dashboard/
- Scanner:       bochmann-dienstleistungen.github.io/richter-pro/scanner/
- Schadenmeldung: bochmann-dienstleistungen.github.io/richter-pro/forms/schaden.html
- Worker:        richter-automation.richter-makler.workers.dev (Update)

---

## Morgen früh starten mit

claude: "richter pro build starten"
→ Ich baue alles in dieser Reihenfolge durch ohne Unterbrechung

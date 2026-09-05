'use strict';
/* Körs i varje webbsidas kontext (isolerat). Sköter autofyll av sparade
 * inloggningar och fångar nya när du loggar in. Allt defensivt – får aldrig
 * krascha sidan. */
const { ipcRenderer } = require('electron');
/* Popunder-vakt: huvudprocessen får veta vad senaste klicket satt på (länk eller inte) INNAN
 * sidans egna hanterare hinner öppna något. En ny flik till en annan sajt tillåts sedan bara
 * om klicket satt på en riktig länk dit. Synkront så ordningen är garanterad. */
(function () {
  const report = (href) => { try { ipcRenderer.sendSync('page:click', { href: href || null }); } catch {} };
  const linkOf = (t) => { try { const a = t && t.closest ? t.closest('a[href]') : null; return a ? a.href : null; } catch { return null; } };
  window.addEventListener('pointerdown', (e) => report(linkOf(e.target)), true);
  window.addEventListener('mousedown', (e) => report(linkOf(e.target)), true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') report(linkOf(document.activeElement)); }, true);
})();

function findFields() {
  const pw = document.querySelector('input[type=password]');
  if (!pw) return null;
  const scope = pw.form || document;
  const inputs = Array.from(scope.querySelectorAll('input'));
  let user = null;
  for (const inp of inputs) {
    if (inp === pw) break;
    const t = (inp.type || 'text').toLowerCase();
    if (['text', 'email', 'tel'].includes(t) || /user|email|e-?post|login|namn/i.test(inp.name || '')) user = inp;
  }
  if (!user) user = inputs.find((i) => i !== pw && ['text', 'email', 'tel'].includes((i.type || 'text').toLowerCase())) || null;
  return { pw, user };
}

async function autofill() {
  try {
    const f = findFields(); if (!f) return;
    const creds = await ipcRenderer.invoke('pw:get', location.origin);
    if (!creds) return;
    if (f.user && !f.user.value) { f.user.value = creds.username; f.user.dispatchEvent(new Event('input', { bubbles: true })); }
    if (f.pw && !f.pw.value) { f.pw.value = creds.password; f.pw.dispatchEvent(new Event('input', { bubbles: true })); }
  } catch {}
}

function hookCapture() {
  try {
    document.addEventListener('submit', (e) => {
      try {
        const form = e.target;
        const pw = form && form.querySelector && form.querySelector('input[type=password]');
        if (!pw || !pw.value) return;
        const f = findFields();
        const username = (f && f.user && f.user.value) || '';
        ipcRenderer.send('pw:capture', { origin: location.origin, username, password: pw.value });
      } catch {}
    }, true);
  } catch {}
}

/* ── Vaka Wallet: kortfält i kassor ──────────────────────────────────────
 * Hittar kortfält (nummer/giltighet/CVC/namn) via autocomplete-attribut och
 * vanliga namn/id-mönster. Vid submit fångas kortet → huvudprocessen erbjuder
 * att spara. Vid laddning, om fält finns, ber vi skalet visa autofyll-notisen. */
function pick(re, extra) {
  const els = Array.from(document.querySelectorAll('input, [contenteditable="true"]'));
  for (const el of els) {
    if (el.type === 'hidden' || el.type === 'password') continue;
    const hay = [el.autocomplete, el.name, el.id, el.getAttribute && el.getAttribute('aria-label'), el.placeholder].map((s) => (s || '').toLowerCase()).join(' ');
    if (re.test(hay)) return el;
    if (extra && extra.test(hay)) return el;
  }
  return null;
}
function findCardFields() {
  const number = pick(/\bcc-number\b|cardnumber|card-number|cardnum|ccnum|\bcc-num\b/, /\bcard\b.*\bnumber\b|\bnumber\b.*\bcard\b/);
  if (!number) return null;
  return {
    number,
    exp: pick(/\bcc-exp\b|cc-expiry|card-expiry|\bexpiry\b|\bexp-date\b|expiration|\bmm\s*\/?\s*yy\b/),
    cvc: pick(/\bcc-csc\b|\bcvc\b|\bcvv\b|\bcsc\b|security-code|securitycode/),
    holder: pick(/\bcc-name\b|cardholder|card-name|card-holder|name-on-card|nameoncard/),
  };
}
function setVal(el, v) {
  if (!el || v == null || v === '') return;
  try {
    if (el.isContentEditable) { el.textContent = v; }
    else { if (el.value) return; el.value = v; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch {}
}
function readCard(f) {
  const val = (el) => (el ? (el.isContentEditable ? el.textContent : el.value) || '' : '');
  return { number: val(f.number), exp: val(f.exp), cvc: val(f.cvc), holder: val(f.holder) };
}
function walletRun() {
  try {
    const f = findCardFields(); if (!f) return;
    // Erbjud autofyll när sidan laddat med tomt kortfält
    if (!(f.number.value || '').replace(/\D/g, '')) ipcRenderer.send('wallet:field-detected');
    // Fånga kort vid köp (submit eller klick på köp-knapp)
    const capture = () => { try { const c = readCard(f); if (c.number.replace(/\D/g, '').length >= 12) ipcRenderer.send('wallet:capture', c); } catch {} };
    document.addEventListener('submit', capture, true);
    document.addEventListener('click', (e) => { const t = e.target && e.target.closest && e.target.closest('button,[type=submit],a'); if (t && /betala|köp|pay|order|slutför|checkout|purchase/i.test(t.textContent || '')) setTimeout(capture, 0); }, true);
  } catch {}
}
ipcRenderer.on('wallet-do-fill', (_e, card) => {
  try {
    const f = findCardFields(); if (!f) return;
    setVal(f.number, card.number);
    setVal(f.exp, card.exp);
    setVal(f.cvc, card.cvc);
    setVal(f.holder, card.holder);
  } catch {}
});

/* ── Forget: sök på Ahmia ─────────────────────────────────────────────────
 * Ahmia tar inte emot ?q= direkt — sökformuläret har ett dolt fält som fylls i
 * av deras egen JS, och utan det skickas man tillbaka till startsidan. Därför
 * skickar skalet användaren till Ahmias START-sida med frågan i adressens
 * hash (#fq=…). Hashen når aldrig servern; här nedanför fyller vi i formuläret
 * och skickar det som en vanlig sökning. */
const AHMIA_HOSTS = /(^|\.)ahmia\.fi$|^juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd\.onion$/i;
function ahmiaSearch() {
  try {
    if (!AHMIA_HOSTS.test(location.hostname)) return;
    const m = (location.hash || '').match(/(?:^#|&)fq=([^&]*)/);
    if (!m) return;
    let q = '';
    try { q = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { q = m[1]; }
    if (!q) return;
    const tryFill = (left) => {
      const input = document.querySelector('form input[name=q]');
      const form = input && input.form;
      if (!input || !form) { if (left > 0) setTimeout(() => tryFill(left - 1), 150); return; }
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Låt deras egen JS hinna sätta det dolda fältet innan vi skickar.
      setTimeout(() => { try { form.submit(); } catch {} }, 120);
    };
    tryFill(20);
  } catch {}
}

function run() { autofill(); hookCapture(); walletRun(); ahmiaSearch(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
else run();

/* Helskärmsminne för main.js: när skrivbordet (GNOME Wayland) släpper
 * helskärmen vid fokusförlust ber huvudprocessen sidan gå tillbaka i sin
 * helskärm. Elementet minns vi här, för efter ett ofrivilligt utträde är
 * document.fullscreenElement redan null. Ligger i den isolerade världen,
 * nås via executeJavaScriptInIsolatedWorld(999). */
try {
  let lastFs = null;
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) lastFs = document.fullscreenElement; });
  window.__vakaRefull = () => {
    try { if (lastFs && lastFs.isConnected && !document.fullscreenElement) lastFs.requestFullscreen().catch(() => {}); } catch {}
  };
} catch {}

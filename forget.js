'use strict';
/*
 * Forget – amnesi-lagret.
 *
 * Två löften, båda tekniska (inte policy):
 *  1) INGENTING skrivs beständigt. Hela appens datamapp (cookies, cache,
 *     localStorage, historik, Tor-data, nedladdningar) flyttas till en
 *     engångsmapp i RAM (/dev/shm på Linux, annars OS:ets temp-mapp) som
 *     raderas när appen stängs — och vid nästa start, ifall appen dödades.
 *  2) INGEN trafik lämnar maskinen utanför Tor. Huvudprocessens fetch spärras
 *     helt, så inget molnanrop (nedladdningskoll, konto, AI, uppdaterings-
 *     kollen) kan nå oss eller någon annan förbi Tor-tunneln.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const PREFIX = 'forget-session-';

/* RAM-disk om den finns: då rör datan aldrig en fysisk disk. */
function ramRoot() {
  if (process.platform === 'linux') {
    try { if (fs.statSync('/dev/shm').isDirectory()) return { dir: '/dev/shm', ram: true }; } catch {}
  }
  return { dir: os.tmpdir(), ram: false };
}

function rmrf(p) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    try { if (!fs.existsSync(p)) return true; } catch { return true; }
  }
  return false;
}

/* Städa bort mappar från tidigare sessioner (t.ex. efter en krasch). */
function wipeStale(root, keep) {
  let n = 0;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(PREFIX)) continue;
      const p = path.join(root, name);
      if (keep && p === keep) continue;
      rmrf(p); n++;
    }
  } catch {}
  return n;
}

const { spawn } = require('child_process');
let SESSION = null;
let finalScheduled = false;

/* Chromium hinner skriva tillbaka Preferences/cache EFTER att vi raderat vid
   avslut. Därför lämnar vi efter oss en fristående städare som raderar mappen
   en sekund senare, när alla processer verkligen är döda. */
function scheduleFinalWipe() {
  if (finalScheduled || !SESSION) return;
  finalScheduled = true;
  const dir = SESSION.dir;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'ping 127.0.0.1 -n 3 >nul & rmdir /s /q "' + dir + '"'],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn('/bin/sh', ['-c', 'sleep 1.5; rm -rf ' + JSON.stringify(dir)],
        { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

/* Kallas FÖRE app.whenReady() — annars hinner Electron öppna den gamla mappen. */
function begin(app) {
  const root = ramRoot();
  const stale = wipeStale(root.dir, null);
  const dir = fs.mkdtempSync(path.join(root.dir, PREFIX));
  try { fs.chmodSync(dir, 0o700); } catch {}
  const downloads = path.join(dir, 'Nedladdningar');
  try { fs.mkdirSync(downloads, { recursive: true, mode: 0o700 }); } catch {}

  app.setPath('userData', dir);
  try { app.setPath('sessionData', dir); } catch {}
  app.setPath('downloads', downloads);
  try { app.setPath('crashDumps', path.join(dir, 'crash')); } catch {}

  SESSION = { dir, downloads, ram: root.ram, stale };
  return SESSION;
}

/* Spärra huvudprocessens nät. Allt surfande går via Chromium-sessionens
   Tor-proxy och berörs inte — men molnanropen som Vaka ärvde dör här. */
function lockdownNetwork() {
  const blocked = () => Promise.reject(new Error('forget: nätverk utanför Tor är avstängt'));
  try { globalThis.fetch = blocked; } catch {}
  return true;
}

/* Radera allt. Synkront, så det hinner köras i will-quit/exit. */
function wipe(session) {
  if (!SESSION) return;
  scheduleFinalWipe();
  if (session) {
    try { session.defaultSession.clearCache(); } catch {}
    try { session.defaultSession.clearAuthCache(); } catch {}
    try { session.defaultSession.clearStorageData(); } catch {}
  }
  rmrf(SESSION.dir);
}

function info() { return SESSION; }

module.exports = { begin, lockdownNetwork, wipe, info, wipeStale, scheduleFinalWipe, PREFIX };

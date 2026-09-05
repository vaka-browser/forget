'use strict';
/*
 * Forget – uppdatering som går genom Tor.
 *
 * electron-updater duger inte här: den har en egen HTTP-stack som struntar i
 * Chromiums proxy, så varje koll hade avslöjat din riktiga IP för GitHub. Den
 * här modulen använder Electrons `net` mot standard-sessionen — samma session
 * som allt surfande — och därmed samma Tor-tunnel.
 *
 * Flödet: kolla (liten JSON) → berätta att det finns en ny version → användaren
 * väljer att hämta (stor fil, tar tid över Tor) → byt ut filen → starta om.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, net, shell } = require('electron');

const REPO = 'northcrafto/forget-dl';
const ASSET = { linux: 'Forget.AppImage', win32: 'Forget-Setup.exe', darwin: 'Forget-mac.zip' };
const CHECK_AFTER = 20 * 1000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

let state = { phase: 'idle', version: '', url: '', size: 0, got: 0, file: '' };
let notify = () => {};

function newer(a, b) {                       // a > b ?
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}

/* Var hamnar den hämtade filen? Aldrig i sessionsmappen (den ligger i RAM och
   raderas vid stängning) — en uppdatering måste överleva omstarten. */
function targetPaths() {
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    const cur = process.env.APPIMAGE;
    return { current: cur, tmp: cur + '.new' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forget-update-'));
  return { current: '', tmp: path.join(dir, ASSET[process.platform] || 'forget-update') };
}

async function check(manual) {
  if (state.phase === 'downloading') return state;
  try {
    const r = await net.fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { 'User-Agent': 'Forget', accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    const version = String((j && j.tag_name) || '').replace(/^v/, '');
    if (!version || !newer(version, app.getVersion())) {
      state = { ...state, phase: 'idle', version: '' };
      if (manual) notify('toast', 'Du har redan senaste versionen.');
      return state;
    }
    const want = ASSET[process.platform];
    const asset = (j.assets || []).find((a) => a.name === want);
    if (!asset) { if (manual) notify('toast', 'Ingen fil för din plattform i den nya versionen.'); return state; }
    state = { phase: 'available', version, url: asset.browser_download_url, size: asset.size || 0, got: 0, file: '' };
    notify('update-available', { version, size: state.size });
    return state;
  } catch (e) {
    if (manual) notify('toast', 'Kunde inte kolla efter uppdatering just nu.');
    return state;
  }
}

async function download() {
  if (state.phase !== 'available' || !state.url) return { ok: false };
  const { current, tmp } = targetPaths();
  state.phase = 'downloading'; state.got = 0;
  notify('update-progress', { pct: 0, version: state.version });
  try {
    const r = await net.fetch(state.url, { headers: { 'User-Agent': 'Forget' } });
    if (!r.ok || !r.body) throw new Error('http ' + r.status);
    const total = Number(r.headers.get('content-length')) || state.size || 0;
    const out = fs.createWriteStream(tmp, { mode: 0o755 });
    const reader = r.body.getReader();
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      state.got += value.length;
      const pct = total ? Math.floor((state.got / total) * 100) : 0;
      if (pct !== last) { last = pct; notify('update-progress', { pct, version: state.version }); }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (total && state.got < total * 0.98) throw new Error('ofullständig fil');
    state.file = tmp; state.phase = 'ready';
    notify('update-ready', state.version);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    state.phase = 'available'; state.file = '';
    notify('update-failed', (e && e.message) || 'fel');
    return { ok: false, error: (e && e.message) || 'fel' };
  }
  finally { void current; }
}

/* Installera: Linux byter ut AppImage-filen och startar om. Windows kör
   installeraren. macOS öppnar zip-filen (osignerad → användaren drar in den). */
function install() {
  if (state.phase !== 'ready' || !state.file) return false;
  try {
    if (process.platform === 'linux' && process.env.APPIMAGE) {
      const cur = process.env.APPIMAGE;
      fs.chmodSync(state.file, 0o755);
      fs.renameSync(state.file, cur);
      app.relaunch({ execPath: cur, args: [] });
      app.quit();
      return true;
    }
    if (process.platform === 'win32') {
      const { spawn } = require('child_process');
      spawn(state.file, [], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
      return true;
    }
    shell.showItemInFolder(state.file);
    return true;
  } catch (e) { notify('update-failed', (e && e.message) || 'fel'); return false; }
}

function start(broadcast) {
  notify = broadcast || (() => {});
  setTimeout(() => { check(false); }, CHECK_AFTER);
  setInterval(() => { check(false); }, CHECK_EVERY);
}

module.exports = { start, check, download, install, getState: () => state };

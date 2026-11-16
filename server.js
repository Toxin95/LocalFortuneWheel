// La Ruota della Fortuna - server di gioco (nessuna dipendenza: basta Node.js 18+)
// Avvio:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = crypto.randomBytes(4).toString('hex'); // chiave del presentatore, sta nel QR
const PUB = path.join(__dirname, 'public');
const FRASI = path.join(__dirname, 'frasi.json');
const MAX_LEN = 90;

// ---------- rete ----------
const dgram = require('dgram');

// Tutti gli IPv4 del PC, scartando le schede virtuali (VirtualBox, WSL, Docker, VPN...)
function lanIps() {
  const virtuali = /virtualbox|vmware|vethernet|wsl|hyper-v|docker|loopback|vpn|tailscale|zerotier/i;
  const out = [];
  for (const [nome, list] of Object.entries(os.networkInterfaces())) {
    if (virtuali.test(nome)) continue;
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('192.168.56.')) out.push(i.address);
    }
  }
  return out;
}

// IP della scheda che il PC usa davvero per uscire in rete (quella con il gateway:
// Wi-Fi o cavo). Si chiede al sistema quale indirizzo userebbe per raggiungere
// un host esterno: con UDP non viene spedito nessun pacchetto.
function primaryIp() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (ip) => { try { s.close(); } catch {} resolve(ip); };
    s.once('error', () => done(null));
    try {
      s.connect(53, '1.1.1.1', () => {
        let ip = null;
        try { ip = s.address().address; } catch {}
        done(ip && ip !== '0.0.0.0' ? ip : null);
      });
    } catch { done(null); }
  });
}

let IPS = [];
let HOST_URL = '';

// ---------- stato di gioco ----------
let game = { id: 0, phase: 'lobby', phrase: '', hint: '', called: [] };
const clients = new Set(); // { res, role }

const base = (ch) => ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const isLetter = (ch) => /\p{L}/u.test(ch);

function cells() {
  return [...game.phrase].map((ch) => {
    if (ch === ' ') return { k: 's' };                 // spazio
    if (!isLetter(ch)) return { k: 'p', c: ch };       // punteggiatura / numeri: sempre visibili
    const shown = game.phase === 'solved' || game.called.includes(base(ch));
    return { k: 'l', c: shown ? ch : null };           // lettera
  });
}

function countOf(letter) {
  return [...game.phrase].filter((ch) => isLetter(ch) && base(ch) === letter).length;
}

function stateFor(role) {
  const s = {
    id: game.id,
    phase: game.phase,
    hint: game.hint,
    cells: cells(),
    called: game.called.map((l) => ({ l, n: countOf(l) })),
    hostOnline: [...clients].some((c) => c.role === 'host'),
  };
  if (role === 'host') s.phrase = game.phrase;
  if (role === 'board') s.hostUrl = HOST_URL;
  return s;
}

function broadcast() {
  for (const c of clients) {
    c.res.write(`data: ${JSON.stringify(stateFor(c.role))}\n\n`);
  }
}

// ---------- utilità http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Non trovato'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function loadFrasi() {
  try {
    const list = JSON.parse(fs.readFileSync(FRASI, 'utf8'));
    return list.filter((f) => f && typeof f.frase === 'string').map((f) => ({ frase: f.frase, spunto: String(f.spunto || '') }));
  } catch (e) {
    console.error('frasi.json non leggibile:', e.message);
    return [];
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const isHost = (url.searchParams.get('t') || req.headers['x-token']) === TOKEN;

  // pagine
  if (req.method === 'GET' && p === '/') return sendFile(res, path.join(PUB, 'board.html'));
  if (req.method === 'GET' && p === '/host') return sendFile(res, path.join(PUB, 'host.html'));
  if (req.method === 'GET' && p === '/vendor/qrcode.js') return sendFile(res, path.join(PUB, 'vendor', 'qrcode.js'));

  // flusso eventi (Server-Sent Events)
  if (req.method === 'GET' && p === '/events') {
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'board';
    if (role === 'host' && !isHost) return json(res, 403, { error: 'Chiave non valida: inquadra di nuovo il QR.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const client = { res, role };
    clients.add(client);
    if (role === 'host') broadcast(); else res.write(`data: ${JSON.stringify(stateFor(role))}\n\n`);
    req.on('close', () => { clients.delete(client); if (role === 'host') broadcast(); });
    return;
  }

  // API del presentatore
  if (p.startsWith('/api/')) {
    if (!isHost) return json(res, 403, { error: 'Chiave non valida: inquadra di nuovo il QR.' });

    if (req.method === 'GET' && p === '/api/frasi') return json(res, 200, loadFrasi());

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (p === '/api/start') {
        const phrase = String(body.frase || '').replace(/\s+/g, ' ').trim().toUpperCase();
        const hint = String(body.spunto || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (![...phrase].some(isLetter)) return json(res, 400, { error: 'Scrivi una frase.' });
        if (phrase.length > MAX_LEN) return json(res, 400, { error: `Frase troppo lunga (massimo ${MAX_LEN} caratteri).` });
        game = { id: game.id + 1, phase: 'playing', phrase, hint, called: [] };
        broadcast();
        return json(res, 200, { ok: true });
      }

      if (p === '/api/letter') {
        const l = base(String(body.l || '').trim().slice(0, 1));
        if (game.phase !== 'playing') return json(res, 400, { error: 'Nessuna partita in corso.' });
        if (!/^[A-Z]$/.test(l)) return json(res, 400, { error: 'Lettera non valida.' });
        if (game.called.includes(l)) return json(res, 400, { error: `La ${l} è già stata chiamata.` });
        game.called.push(l);
        broadcast();
        return json(res, 200, { ok: true, l, n: countOf(l) });
      }

      if (p === '/api/solve') {
        if (game.phase !== 'playing') return json(res, 400, { error: 'Nessuna partita in corso.' });
        game.phase = 'solved';
        broadcast();
        return json(res, 200, { ok: true });
      }

      if (p === '/api/reset') {
        game = { id: game.id + 1, phase: 'lobby', phrase: '', hint: '', called: [] };
        broadcast();
        return json(res, 200, { ok: true });
      }
    }
  }

  res.writeHead(404); res.end('Non trovato');
});

// tiene vive le connessioni
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000);

(async () => {
  const main = await primaryIp();
  IPS = lanIps();
  const ip = process.env.HOST_IP || main || IPS[0] || 'localhost';
  HOST_URL = `http://${ip}:${PORT}/host?t=${TOKEN}`;
  const altri = IPS.filter((a) => a !== ip);

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  LA RUOTA DELLA FORTUNA\n');
    console.log(`  Tabellone (apri su questo PC):  http://localhost:${PORT}`);
    console.log(`  Presentatore (telefono):        ${HOST_URL}`);
    if (altri.length) console.log(`\n  Altri indirizzi di rete trovati: ${altri.join(', ')}\n  (se il QR non funziona riavvia con  set HOST_IP=<indirizzo>  prima di node server.js)`);
    console.log('\n  Il telefono deve essere sulla stessa rete Wi-Fi del PC.\n');
  });
})();

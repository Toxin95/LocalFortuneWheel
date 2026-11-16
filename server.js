// Local Fortune Wheel - modalità LAN (nessuna dipendenza: basta Node.js 18+)
// Telefono e tabellone parlano con questo server nella rete locale: non serve internet.
// Avvio:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const { createGame, apply } = require('./public/game.js');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = crypto.randomBytes(4).toString('hex'); // chiave del presentatore, sta nel QR
const PUB = path.join(__dirname, 'public');
const FRASI = path.join(PUB, 'frasi.json');

// ---------- rete ----------

// Tutti gli IPv4 del PC, scartando le schede virtuali (VirtualBox, WSL, Docker, VPN...)
function lanIps() {
  const virtuali = /virtualbox|vmware|vethernet|wsl|hyper-v|docker|loopback|vpn|tailscale|zerotier/i;
  const out = [];
  for (const [nome, list] of Object.entries(os.networkInterfaces())) {
    if (virtuali.test(nome)) continue;
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (i.address.startsWith('192.168.56.') || i.address.startsWith('169.254.')) continue; // VirtualBox / scheda senza rete
      out.push(i.address);
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

// Indirizzi da proporre nel QR, il più probabile per primo. Vengono ricalcolati
// di continuo: se il PC cambia rete (Wi-Fi, cavo, VPN) il QR si aggiorna da solo.
let IPS = [];
const hostUrl = (ip) => `http://${ip}:${PORT}/host?t=${TOKEN}`;

async function refreshNetwork() {
  let ips;
  if (process.env.HOST_IP) ips = [process.env.HOST_IP];
  else {
    const main = await primaryIp();
    const all = lanIps();
    ips = [...new Set([main, ...all].filter((ip) => ip && all.includes(ip)))];
    if (!ips.length) ips = main ? [main] : ['localhost'];
  }
  const changed = ips.join() !== IPS.join();
  IPS = ips;
  return changed;
}

// ---------- stato di gioco ----------
const game = createGame();
const clients = new Set(); // { res, role }

function stateFor(role) {
  const s = game.state(role, [...clients].some((c) => c.role === 'host'));
  if (role === 'board') s.hostUrls = IPS.map(hostUrl);
  return s;
}

function broadcast() {
  for (const c of clients) c.res.write(`data: ${JSON.stringify(stateFor(c.role))}\n\n`);
}

// ---------- utilità http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

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

  // le pagine capiscono da qui che stanno girando in modalità LAN
  if (req.method === 'GET' && p === '/lan') return json(res, 200, { lan: true });

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
      try {
        const out = apply(game, { ...body, type: p.slice(5) });
        broadcast();
        return json(res, 200, { ok: true, ...out });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    return json(res, 404, { error: 'Non trovato' });
  }

  // pagine e file statici (cartella public)
  if (req.method === 'GET') {
    let rel = p === '/' ? 'index.html' : p === '/host' ? 'host.html' : p.slice(1);
    try { rel = decodeURIComponent(rel); } catch { rel = ''; }
    const file = path.resolve(PUB, rel);
    if (rel && file.startsWith(PUB + path.sep)) return sendFile(res, file);
  }

  res.writeHead(404); res.end('Non trovato');
});

// tiene vive le connessioni
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000);

(async () => {
  await refreshNetwork();

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  LOCAL FORTUNE WHEEL (modalità LAN)\n');
    console.log(`  Tabellone (apri su questo PC):  http://localhost:${PORT}`);
    console.log(`  Presentatore (telefono):        ${hostUrl(IPS[0])}`);
    if (IPS.length > 1) console.log(`\n  Altri indirizzi di rete trovati: ${IPS.slice(1).join(', ')}\n  (se il QR non funziona, sul tabellone clicca "Cambia indirizzo")`);
    console.log('\n  Il telefono deve essere sulla stessa rete Wi-Fi del PC.\n');
  });

  setInterval(async () => {
    if (await refreshNetwork()) {
      console.log(`  Rete cambiata, nuovo indirizzo presentatore: ${hostUrl(IPS[0])}`);
      broadcast();
    }
  }, 5000);
})();

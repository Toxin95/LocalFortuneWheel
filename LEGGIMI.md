# La Ruota della Fortuna

Serve solo Node.js 18 o superiore, nessun `npm install`.

## Avvio
1. Apri un terminale in questa cartella e lancia `node server.js`
2. Sul PC collegato allo schermo apri `http://localhost:3000` (F11 per lo schermo intero)
3. Il presentatore inquadra il QR con il telefono (stessa rete Wi-Fi del PC)
4. Dal telefono: scrivi una frase con il suo spunto oppure scegline una dall'elenco, poi tocca le lettere chiamate dai concorrenti e premi INDOVINATO! (due tocchi) quando qualcuno indovina

## Frasi
Le frasi dell'elenco stanno in `frasi.json` (`spunto` + `frase`). Puoi modificarlo anche a server acceso.

## Se il telefono non si collega
- Windows Firewall: alla prima esecuzione consenti a Node.js l'accesso alle reti private
- Il QR usa da solo la scheda con cui il PC è collegato alla rete (Wi-Fi o cavo). Per forzare un indirizzo: `set HOST_IP=192.168.x.x` e poi `node server.js`
- Porta diversa: `set PORT=8080`

## File
- `server.js`: server e regole del gioco
- `public/board.html`: tabellone
- `public/host.html`: telecomando del presentatore
- `public/vendor/qrcode.js`: libreria QR (qrcode-generator, licenza MIT)

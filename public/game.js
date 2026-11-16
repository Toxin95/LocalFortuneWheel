// Local Fortune Wheel - regole del gioco.
// Usato sia da server.js (modalità LAN) sia dal tabellone nel browser (modalità online).
(function (root) {
  const MAX_LEN = 90;

  const base = (ch) => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const isLetter = (ch) => /\p{L}/u.test(ch);
  const empty = (id) => ({ id, phase: 'lobby', phrase: '', hint: '', called: [] });

  function createGame(saved) {
    let g = saved && typeof saved === 'object' && typeof saved.phrase === 'string' && Array.isArray(saved.called)
      ? saved : empty(0);

    const countOf = (l) => [...g.phrase].filter((ch) => isLetter(ch) && base(ch) === l).length;

    function cells() {
      return [...g.phrase].map((ch) => {
        if (ch === ' ') return { k: 's' };                 // spazio
        if (!isLetter(ch)) return { k: 'p', c: ch };       // punteggiatura / numeri: sempre visibili
        const shown = g.phase === 'solved' || g.called.includes(base(ch));
        return { k: 'l', c: shown ? ch : null };           // lettera
      });
    }

    const fail = (msg) => { throw new Error(msg); };

    return {
      get data() { return g; },

      // Stato da mandare a tabellone ('board') o telefono ('host')
      state(role, hostOnline) {
        const s = {
          id: g.id, phase: g.phase, hint: g.hint, cells: cells(),
          called: g.called.map((l) => ({ l, n: countOf(l) })),
          hostOnline: !!hostOnline,
        };
        if (role === 'host') s.phrase = g.phrase;
        return s;
      },

      start(frase, spunto) {
        const phrase = String(frase || '').replace(/\s+/g, ' ').trim().toUpperCase();
        const hint = String(spunto || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (![...phrase].some(isLetter)) fail('Scrivi una frase.');
        if (phrase.length > MAX_LEN) fail(`Frase troppo lunga (massimo ${MAX_LEN} caratteri).`);
        g = { id: g.id + 1, phase: 'playing', phrase, hint, called: [] };
        return {};
      },

      letter(x) {
        const l = base(String(x || '').trim().slice(0, 1));
        if (g.phase !== 'playing') fail('Nessuna partita in corso.');
        if (!/^[A-Z]$/.test(l)) fail('Lettera non valida.');
        if (g.called.includes(l)) fail(`La ${l} è già stata chiamata.`);
        g.called.push(l);
        return { l, n: countOf(l) };
      },

      solve() {
        if (g.phase !== 'playing') fail('Nessuna partita in corso.');
        g.phase = 'solved';
        return {};
      },

      reset() {
        g = empty(g.id + 1);
        return {};
      },
    };
  }

  // Esegue un comando del presentatore: { type: 'start' | 'letter' | 'solve' | 'reset', ... }
  function apply(game, msg) {
    switch (msg && msg.type) {
      case 'start': return game.start(msg.frase, msg.spunto);
      case 'letter': return game.letter(msg.l);
      case 'solve': return game.solve();
      case 'reset': return game.reset();
      default: throw new Error('Comando sconosciuto.');
    }
  }

  const api = { createGame, apply, MAX_LEN };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FortuneWheel = api;
})(this);

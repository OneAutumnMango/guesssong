(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const app = $('app');

  // --- key handling: hash -> sessionStorage, then scrub the URL
  let key = null;
  try {
    const m = /(?:^#|&)key=([^&]+)/.exec(location.hash);
    if (m) {
      sessionStorage.setItem('key', decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    key = sessionStorage.getItem('key');
  } catch (e) { /* storage blocked */ }
  if (!key) {
    const m = /(?:^#|&)key=([^&]+)/.exec(location.hash);
    if (m) { key = decodeURIComponent(m[1]); history.replaceState(null, '', location.pathname + location.search); }
  }

  // --- DOM helper: text only, never innerHTML
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k.startsWith('data-')) n.setAttribute(k, v);
      else n[k] = v;
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  }
  const btn = (text, onclick, cls, focus) => el('button', { type: 'button', text, onclick, class: cls || '', 'data-focus': focus || text });

  // --- socket
  let ws = null, retry = 0, view = null, closing = false, awaitingHello = false;
  let guessErrTimer = null, localDeadline = null, timeUp = false, guessBtns = [], guessPending = false;
  function clearGuessErr() { clearTimeout(guessErrTimer); guessErrTimer = null; }
  function send(msg) { clearGuessErr(); showError(''); if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function showError(msg) { const e = $('error'); e.textContent = msg || ''; e.hidden = !msg; }
  function ended(msg) {
    if (controller && controller.pause) controller.pause();
    clearInterval(tick);
    $('error').hidden = true;
    app.replaceChildren(el('p', { text: msg }), el('p', {}, el('a', { href: '/', text: 'Home page' })));
    setEmbedVisible(false); $('embed-note').hidden = true;
  }
  window.addEventListener('pagehide', () => { closing = true; });
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { awaitingHello = true; retry = 0; $('banner').hidden = true; send({ type: 'hello', key }); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'error') {
        if (awaitingHello) { // hello rejected: terminal, do not retry
          closing = true; ws.close();
          if (!view || view.phase !== 'finished') ended('That game is no longer running');
        }
        else {
          guessPending = false;
          showError(String(m.message));
          if (view.phase === 'playing') { // keep guess rejections visible ~3s despite later state broadcasts
            clearGuessErr(); const msg = String(m.message);
            guessErrTimer = setTimeout(() => { guessErrTimer = null; if ($('error').textContent === msg) showError(''); }, 3000);
            if (!timeUp && !view.myGuess) for (const b of guessBtns) b.disabled = false;
          }
        }
      }
      else if (m.type === 'state') {
        awaitingHello = false; if (!guessErrTimer) showError(''); view = m.view;
        if (view.myGuess || view.phase !== 'playing') guessPending = false;
        const rm = view.round && view.round.remainingMs;
        localDeadline = view.phase === 'playing' && Number.isFinite(rm) ? performance.now() + rm : null;
        render();
      }
    };
    ws.onclose = (ev) => {
      if (closing) return;
      if (ev.code === 1000) { closing = true; if (!view || view.phase !== 'finished') ended('This session ended (opened elsewhere or the room closed). Rejoin from the home page.'); $('banner').hidden = true; return; }
      $('banner').textContent = 'Reconnecting…';
      $('banner').hidden = false;
      setTimeout(connect, Math.min(1000 * 2 ** retry, 5000));
      retry++;
    };
  }

  // --- host audio: the Spotify embed stays rendered but off-screen; the app's own UI drives it
  let controller = null, apiFailed = false, loadedUri = null, pendingUri = null;
  let playClicked = false, playSent = false, fallback = false, watchTimer = null, embedPhase = null;
  let audioStarted = false, audioPos = 0, audioDur = 0;
  function setEmbedVisible(v) {
    const w = $('embed-wrap');
    w.className = v ? 'embed-visible' : 'embed-hidden';
    w.setAttribute('aria-hidden', v ? 'false' : 'true');
  }
  function onPlayback(e) {
    const d = (e && e.data) || {};
    audioPos = Number(d.position) || 0; audioDur = Number(d.duration) || 0;
    audioStarted = d.isPaused === false && !d.isBuffering;
    const pr = $('audio-progress');
    if (pr) { pr.max = audioDur || 1; pr.value = Math.min(audioPos, audioDur || 1); }
    const st = $('audio-status');
    if (st) st.textContent = audioStarted ? 'Playing' : 'Waiting for audio…';
    if (!view || view.you !== view.hostId) return;
    // the round starts when sound starts: either our Play click or the embed's own button (fallback)
    if (audioStarted && view.phase === 'between' && !playSent && (playClicked || fallback)) {
      playSent = true; fallback = false;
      clearTimeout(watchTimer);
      send({ type: 'play' });
      syncEmbed();
    }
  }
  function startWatch() {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      if (view && view.phase === 'between' && !playSent) { fallback = true; render(); }
    }, 3000);
  }
  function loadEmbedScript() {
    window.onSpotifyIframeApiReady = (IFrameAPI) => {
      const created = pendingUri || 'spotify:track:0000000000000000000000';
      IFrameAPI.createController($('embed').appendChild(document.createElement('div')),
        { uri: created, width: '100%', height: 80 }, (c) => {
          controller = c; loadedUri = created;
          c.addListener('playback_update', onPlayback);
          if (pendingUri && pendingUri !== created) { c.loadUri(pendingUri); loadedUri = pendingUri; }
        });
    };
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.async = true;
    s.onerror = () => { apiFailed = true; if (view) render(); };
    document.head.appendChild(s);
  }
  let embedStarted = false;
  function syncEmbed() {
    if (view.you !== view.hostId) return;
    if (embedPhase !== view.phase) { // new phase: reset the play guards
      embedPhase = view.phase;
      playClicked = playSent = fallback = false;
      clearTimeout(watchTimer);
      if (view.phase === 'between' && controller && controller.pause) controller.pause();
    }
    if (view.phase === 'finished' && controller && controller.pause) controller.pause();
    if (!embedStarted) { embedStarted = true; pendingUri = view.nextUri || null; loadEmbedScript(); }
    const show = fallback && view.phase === 'between' && !apiFailed;
    setEmbedVisible(show);
    const note = $('embed-note');
    note.hidden = !(apiFailed || show);
    note.textContent = apiFailed
      ? 'Could not load the Spotify player. Check your connection or ad blocker and reload; the game cannot play audio without it.'
      : show ? 'Your browser blocked automatic audio. Tap play on the player below to start the round.' : '';
    if (view.nextUri && view.nextUri !== loadedUri) {
      pendingUri = view.nextUri;
      playClicked = playSent = fallback = false;
      if (controller) { controller.loadUri(view.nextUri); loadedUri = view.nextUri; }
    }
  }

  // --- rendering
  let tick = null, lastPhase = null;
  const isHost = () => view.you === view.hostId;
  const tag = (p) => p.name + (p.bot ? ' (test)' : '');
  const nameOf = (id) => { const p = view.players.find((x) => x.id === id); return p ? tag(p) : '?'; };

  function scoreboard() {
    const sorted = [...view.players].sort((a, b) => b.score - a.score);
    const d = (view.reveal && view.reveal.deltas) || {};
    return el('section', { class: 'side' }, el('h2', { text: 'Scoreboard' }),
      el('ul', {}, ...sorted.map((p) => el('li', {},
        el('span', { class: 'grow', text: tag(p) + (p.id === view.you ? ' (you)' : '') }),
        el('span', { text: String(p.score) + (view.phase === 'reveal' && d[p.id] ? ' (+' + d[p.id] + ')' : '') })))));
  }

  function syncQr() {
    const img = $('qr-img'), u = $('qr-url');
    if (!img || !u) return;
    const src = '/qr.svg?room=' + encodeURIComponent(view.code);
    if (img.getAttribute('src') !== src) {
      img.hidden = false; img.parentNode.hidden = false;
      img.src = src;
      img.alt = 'QR code to join room ' + view.code;
    }
    const url = typeof view.joinUrl === 'string' ? view.joinUrl : '';
    if (u.dataset.url === url) return;
    u.dataset.url = url;
    if (/^https?:\/\//.test(url)) {
      const a = el('a', { text: url, rel: 'noopener' });
      a.href = url;
      u.replaceChildren(a);
    } else u.textContent = url;
  }

  function syncBots() {
    const a = document.querySelector('[data-focus="add-bot"]'), r = document.querySelector('[data-focus="remove-bot"]');
    if (a) a.disabled = view.players.length >= 8;
    if (r) r.disabled = !view.players.some((p) => p.bot);
  }

  function lobbyPlayers() {
    return [el('h2', { text: 'Room' }),
      el('p', { class: 'big', text: view.code || '' }),
      el('ul', {}, ...view.players.map((p) => el('li', {},
        el('span', { class: 'grow', text: tag(p) + (p.id === view.hostId ? ' (host)' : '') + (p.id === view.you ? ' (you)' : '') }),
        el('span', { class: 'muted', text: p.connected ? '' : 'offline' }))))];
  }

  function lobby() {
    const out = [];
    out.push(el('section', { id: 'lobby-players', class: 'side' }, ...lobbyPlayers()));
    if (typeof view.code === 'string' && view.code) {
      const img = el('img', { id: 'qr-img', width: 200, height: 200 });
      img.onerror = () => { img.hidden = true; img.parentNode.hidden = true; };
      out.push(el('section', { id: 'lobby-qr', class: 'side' }, el('h2', { text: 'Scan to join' }),
        el('div', { class: 'qr-wrap' }, img), el('p', { id: 'qr-url', class: 'selectable' })));
    }
    if (view.dev && isHost()) {
      out.push(el('section', { id: 'lobby-bots', class: 'side' }, el('h2', { text: 'Test players' }),
        btn('Add test player', () => send({ type: 'addBot' }), '', 'add-bot'),
        btn('Remove test player', () => send({ type: 'removeBot' }), 'secondary', 'remove-bot')));
    }
    if (isHost()) {
      const s = view.settings;
      const source = el('select', { id: 'f-source' }, el('option', { value: 'recents', text: 'Recently played' }), el('option', { value: 'liked', text: 'Liked songs' }));
      source.value = s.source;
      const total = el('input', { id: 'f-total', type: 'number', min: 1, max: 100, step: 1, required: true, value: s.total });
      const buffer = el('input', { id: 'f-buffer', type: 'number', min: 0, max: 20, step: 1, required: true, value: s.buffer });
      const hp = el('input', { id: 'f-hp', type: 'checkbox', checked: s.hostPlays });
      const push = () => {
        if (!total.checkValidity() || !buffer.checkValidity()) { showError('Songs must be 1-100, removals 0-20'); return false; }
        showError('');
        send({ type: 'settings', settings: {
          source: source.value, total: Number(total.value), buffer: Number(buffer.value), hostPlays: hp.checked } });
        return true;
      };
      for (const i of [source, total, buffer, hp]) i.addEventListener('change', push);
      out.push(el('section', { id: 'lobby-settings' }, el('h2', { text: 'Settings' }),
        el('label', { htmlFor: 'f-source', text: 'Song source' }), source,
        el('label', { htmlFor: 'f-total', text: 'Total songs (1-100)' }), total,
        el('label', { htmlFor: 'f-buffer', text: 'Removals per player (0-20)' }), buffer,
        el('label', { htmlFor: 'f-hp' }, hp, 'I play too (host guesses)'),
        btn('Start', () => { if (push()) send({ type: 'start' }); })));
    } else {
      out.push(el('p', { class: 'muted', text: 'Waiting for the host to start…' }));
    }
    return out;
  }

  function review() {
    const me = view.players.find((p) => p.id === view.you);
    const tracks = view.myTracks;
    if (!tracks) return [el('p', { text: 'Waiting for the other players…' })];
    const left = view.removalsLeft || 0;
    const out = [el('section', {}, el('h2', { text: 'Your songs' }),
      el('p', { class: 'muted', text: left > 0 ? 'Remove songs you do not want played. Removals left: ' + left : 'No removals left.' }),
      el('ul', {}, ...tracks.map((t) => el('li', { class: 'track' },
        el('span', { text: t.title }), el('span', { class: 'muted', text: t.artist }),
        left > 0 && tracks.length > 1 ? btn('Remove', () => send({ type: 'remove', trackId: t.id }), 'secondary', 'remove-' + t.id) : null))))];
    if (me && me.ready) out.push(el('p', { text: 'Ready. Waiting for the others…' }));
    else out.push(btn('Ready', () => send({ type: 'ready' })));
    out.push(el('p', { class: 'muted', text: 'Ready: ' + view.players.filter((p) => p.ready).length + '/' + view.players.length }));
    return out;
  }

  function roundHeader() {
    return el('p', { class: 'muted', text: 'Round ' + (view.round.index + 1) + ' of ' + view.round.total });
  }

  function between() {
    if (isHost()) {
      const starting = playClicked && !fallback && !playSent;
      const b = btn('Play', () => {
        if (apiFailed || !controller) { showError('The Spotify player is not ready yet.'); return; }
        // same user gesture: start audio here; the round starts when the embed reports sound
        playClicked = true; fallback = false; playSent = false;
        try { controller.play(); } catch (e) { showError('Could not start the player.'); }
        startWatch();
        render();
      });
      b.disabled = starting;
      const out = [roundHeader(), b];
      if (starting) out.push(el('p', { class: 'muted', text: 'Starting audio…' }));
      return out;
    }
    return [roundHeader(), el('p', { class: 'big', text: 'Get ready' })];
  }

  function playing() {
    const out = [roundHeader()];
    const cd = el('p', { class: 'big', id: 'countdown' });
    out.push(cd);
    timeUp = false; guessBtns = [];
    const upd = () => {
      if (localDeadline === null) { cd.textContent = ''; return; }
      const ms = Math.max(0, localDeadline - performance.now());
      if (ms === 0) { timeUp = true; cd.textContent = 'Time is up'; for (const b of guessBtns) b.disabled = true; }
      else cd.textContent = Math.ceil(ms / 1000) + 's';
    };
    if (isHost()) {
      out.push(el('p', { id: 'audio-status', class: 'muted', text: audioStarted ? 'Playing' : 'Waiting for audio…' }),
        el('progress', { id: 'audio-progress', max: audioDur || 1, value: Math.min(audioPos, audioDur || 1), 'aria-label': 'Playback progress' }));
    }
    const iAmGuesser = view.settings.hostPlays || !isHost();
    if (!iAmGuesser) {
      out.push(el('p', { text: 'Hosting' }), el('p', { class: 'muted', text: 'Guessed: ' + view.round.guessedCount }));
    } else if (view.iOwnThisSong) {
      out.push(el('p', { text: 'This one is yours! Sit this round out while the others guess.' }));
    } else if (view.myGuess) {
      out.push(el('p', { class: 'big', text: 'Locked in' }));
    } else {
      out.push(el('h2', { text: 'Whose song is this?' }));
      const grid = el('div', { class: 'guess-grid' });
      out.push(grid);
      for (const p of view.players) {
        if (p.id === view.you || (!view.settings.hostPlays && p.id === view.hostId)) continue;
        const b = btn(tag(p), () => { guessPending = true; for (const x of guessBtns) x.disabled = true; send({ type: 'guess', playerId: p.id }); }, '', 'guess-' + p.id);
        b.disabled = guessPending;
        guessBtns.push(b);
        grid.append(b);
      }
    }
    out.push(scoreboard());
    upd(); tick = setInterval(upd, 250);
    return out;
  }

  function reveal() {
    const r = view.reveal;
    const pts = r.deltas[view.you] || 0;
    const out = [roundHeader(),
      el('section', {}, el('h2', { text: 'It was ' + nameOf(r.ownerId) + '’s song' }),
        el('p', { text: r.track.title }), el('p', { class: 'muted', text: r.track.artist }),
        el('p', { text: view.myGuess ? (view.myGuess === r.ownerId ? 'You got it! +' + pts : 'Wrong guess, +0') : 'No guess, +0' })),
      scoreboard()];
    if (isHost()) out.push(btn('Next', () => send({ type: 'next' })));
    return out;
  }

  function finished() { return [el('h2', { text: 'Game over' }), scoreboard()]; }

  const phases = { lobby, review, between, playing, reveal, finished };
  function devBanner() {
    let b = $('dev-banner');
    if (!view.dev) { if (b) b.remove(); return; }
    if (!b) {
      b = el('div', { id: 'dev-banner', text: 'DEV MODE' });
      document.querySelector('main').prepend(b);
    }
  }

  // two columns on desktop (CSS), single column on mobile; inline order keeps the original DOM order there
  function layout(kids) {
    const main = el('div', { class: 'main-col' }), side = el('div', { class: 'side-col' });
    kids.forEach((k, i) => { k.style.order = i; (k.classList.contains('side') ? side : main).append(k); });
    return el('div', { class: 'layout' }, main, side);
  }

  function render() {
    if (view.phase === 'lobby' && lastPhase === 'lobby' && $('lobby-players')) {
      // keep the settings form (typing, focus) intact; only refresh the player list and idle fields
      $('lobby-players').replaceChildren(...lobbyPlayers());
      syncBots();
      syncQr();
      const set = (id, v) => { const f = $(id); if (f && document.activeElement !== f) f[typeof v === 'boolean' ? 'checked' : 'value'] = v; };
      set('f-source', view.settings.source); set('f-total', view.settings.total);
      set('f-buffer', view.settings.buffer); set('f-hp', view.settings.hostPlays);
    } else {
      clearInterval(tick);
      const a = document.activeElement;
      const fk = a && a.dataset ? a.dataset.focus || a.id : null;
      const f = phases[view.phase];
      app.replaceChildren(layout(f ? f() : [el('p', { text: 'Unknown state' })]));
      if (fk) {
        const t = [...app.querySelectorAll('[data-focus],[id]')].find((x) => (x.dataset.focus || x.id) === fk);
        if (t) t.focus();
      }
    }
    if (view.phase === 'lobby') { syncBots(); syncQr(); }
    lastPhase = view.phase;
    devBanner();
    syncEmbed();
  }

  if (!key) { app.replaceChildren(el('p', {}, 'No session. ', el('a', { href: '/', text: 'Go back' }))); }
  else connect();
})();

(function () {
  'use strict';
  const STREAK_MIN = 2;
  const SEAT_KEY = 'gs.seat', SEAT_TTL = 12 * 3600 * 1000;
  const $ = (id) => document.getElementById(id);
  const app = $('app'), appFoot = $('app-foot'), appSide = $('app-side');

  // --- saved seat (localStorage): lets a phone rejoin after a lost connection or closed tab
  function readSeat() {
    try {
      const s = JSON.parse(localStorage.getItem(SEAT_KEY));
      if (s && typeof s.key === 'string' && Date.now() - s.savedAt < SEAT_TTL) return s;
      if (s) localStorage.removeItem(SEAT_KEY);
    } catch (e) { /* storage blocked or bad data */ }
    return null;
  }
  function saveSeat(k, code) { try { localStorage.setItem(SEAT_KEY, JSON.stringify({ key: k, code: code || null, savedAt: Date.now() })); } catch (e) { /* ignore */ } }
  // only remove the seat if it belongs to THIS tab's key (another tab may have saved a newer one)
  function clearSeat() {
    try {
      const s = JSON.parse(localStorage.getItem(SEAT_KEY));
      if (!s || s.key === key) localStorage.removeItem(SEAT_KEY);
    } catch (e) { try { localStorage.removeItem(SEAT_KEY); } catch (e2) { /* ignore */ } }
  }

  // --- key: hash -> sessionStorage -> localStorage seat; the hash is scrubbed after reading
  let key = null, savedCode = null;
  const hm = /(?:^#|&)key=([^&]+)/.exec(location.hash);
  if (hm) {
    try { key = decodeURIComponent(hm[1]); } catch (e) { key = hm[1]; }
    try { sessionStorage.setItem('key', key); } catch (e) { /* ignore */ }
    saveSeat(key, null);
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try { key = sessionStorage.getItem('key'); } catch (e) { /* ignore */ }
    const seat = readSeat();
    if (seat) {
      if (!key) { key = seat.key; try { sessionStorage.setItem('key', key); } catch (e) { /* ignore */ } }
      if (seat.key === key) savedCode = seat.code;
    }
  }
  const roomCode = () => {
    const c = (view && view.code) || savedCode;
    return typeof c === 'string' && /^[A-Z]{4}$/.test(c) ? c : null;
  };

  // --- DOM helper: text only, never innerHTML
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k.startsWith('data-') || k.startsWith('aria-')) n.setAttribute(k, v);
      else n[k] = v;
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  }
  const btn = (text, onclick, cls, focus) => el('button', { type: 'button', text, onclick, class: cls || '', 'data-focus': focus || text });

  // --- socket
  let ws = null, retry = 0, view = null, closing = false, awaitingHello = false, reconnectTimer = null;
  let prevViewPaused = null;
  let guessErrTimer = null, localDeadline = null, timeUp = false, guessBtns = [], guessPending = false;
  let pausedIntent = false, revealClicked = false, lastSent = '', lastLocalPauseAt = -1e9;
  function clearGuessErr() { clearTimeout(guessErrTimer); guessErrTimer = null; }
  function send(msg) { lastSent = msg.type; clearGuessErr(); showError(''); if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function showError(msg) { const e = $('error'); e.textContent = msg || ''; e.hidden = !msg; }
  function ended(msg) {
    if (controller && controller.pause) controller.pause();
    clearInterval(tick); clearInterval(watchTimer);
    $('error').hidden = true; $('banner').hidden = true;
    const code = roomCode();
    mount([el('div', { class: 'terminal' },
      el('p', { text: msg }),
      code ? el('a', { class: 'btn', href: '/login?room=' + encodeURIComponent(code), text: 'Rejoin with Spotify' }) : null,
      el('a', { class: 'btn secondary', href: '/', text: 'Home page' }))]);
    setEmbedVisible(false); $('embed-note').hidden = true;
  }
  window.addEventListener('pagehide', () => { closing = true; });
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  $('retry-now').addEventListener('click', () => {
    clearTimeout(reconnectTimer); retry = 0;
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch (e) { /* ignore */ } }
    connect();
  });
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { awaitingHello = true; retry = 0; guessPending = false; $('banner').hidden = true; send({ type: 'hello', key }); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'error') {
        if (awaitingHello) { // hello rejected: terminal, do not retry
          closing = true; ws.close(); clearSeat();
          if (!view || view.phase !== 'finished') ended('That game is no longer running');
        } else {
          const guessErr = lastSent === 'guess';
          if (guessErr) guessPending = false;
          showError(String(m.message));
          if (revealClicked && view && view.phase === 'playing') { revealClicked = false; const rb = $('reveal-btn'); if (rb) rb.disabled = false; }
          if (view && view.phase === 'playing') { // keep guess rejections visible ~3s despite later state broadcasts
            clearGuessErr(); const msg = String(m.message);
            guessErrTimer = setTimeout(() => { guessErrTimer = null; if ($('error').textContent === msg) showError(''); }, 3000);
            if (guessErr && !timeUp && !view.myGuess) for (const b of guessBtns) b.disabled = false;
          }
        }
      } else if (m.type === 'state') {
        awaitingHello = false; if (!guessErrTimer) showError(''); view = m.view;
        if (view.myGuess || view.phase !== 'playing') guessPending = false;
        if (view.phase === 'finished') clearSeat();
        else if (typeof view.code === 'string' && view.code && view.code !== savedCode) { savedCode = view.code; saveSeat(key, view.code); }
        const r = view.round || {};
        // a state sent before our own pause/resume click was processed must not undo the local intent
        if (performance.now() - lastLocalPauseAt > 1000) pausedIntent = !!r.paused;
        if (view.phase === 'playing' && prevViewPaused !== null && prevViewPaused !== !!r.paused && r.timed !== false) $('live').textContent = r.paused ? 'Round paused' : 'Round resumed';
        prevViewPaused = view.phase === 'playing' ? !!r.paused : null;
        localDeadline = view.phase === 'playing' && Number.isFinite(r.remainingMs) ? performance.now() + r.remainingMs : null;
        render();
      }
    };
    ws.onclose = (ev) => {
      if (closing) return;
      if (ev.code === 1000) { closing = true; if (!view || view.phase !== 'finished') ended('This session ended (opened elsewhere or the room closed). Rejoin from the home page.'); $('banner').hidden = true; return; }
      $('banner-text').textContent = 'Reconnecting…';
      $('banner').hidden = false;
      reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 5000));
      retry++;
    };
  }

  // --- host audio: the Spotify embed stays rendered but off-screen; the app's own UI drives it
  let controller = null, apiFailed = false, loadedUri = null, pendingUri = null, playerLoaded = false;
  let playClicked = false, playSent = false, fallback = false, slowLoad = false, watchTimer = null, embedPhase = null;
  let clickAt = 0, loadedAt = 0, prevPaused;
  let audioStarted = false, audioPlaying = false, audioEnded = false, audioPos = 0, audioDur = 0, seeking = false;
  const timed = () => !!view && !!view.round && view.round.timed !== false;
  const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function setEmbedVisible(v) {
    const w = $('embed-wrap');
    w.className = v ? 'embed-visible' : 'embed-hidden';
    w.setAttribute('aria-hidden', v ? 'false' : 'true');
    w.inert = !v; // off-screen embed must not take keyboard focus
  }
  function sendPause() { if (timed() && !pausedIntent) { pausedIntent = true; send({ type: 'pause' }); } }
  function sendResume() { if (timed() && pausedIntent) { pausedIntent = false; send({ type: 'resume' }); } }
  const timeText = () => fmt(audioPos) + ' / ' + (audioDur ? fmt(audioDur) : '--:--');
  const spoken = () => Math.floor(audioPos / 1000) + ' seconds' + (audioDur ? ' of ' + Math.floor(audioDur / 1000) : '');
  // icon-only toggle: inline SVG built with DOM APIs
  function setIcon(b, kind, label) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'currentColor');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', kind === 'pause' ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M7 4.5v15l13-7.5z');
    svg.append(p);
    b.replaceChildren(svg);
    b.setAttribute('aria-label', label);
  }
  const toggleKind = () => (audioEnded ? ['play', 'Play'] : audioPlaying ? ['pause', 'Pause'] : ['play', 'Resume']);
  function updateAudioUi() {
    const tg = $('audio-toggle');
    if (tg) setIcon(tg, toggleKind()[0], toggleKind()[1]);
    const sk = $('audio-seek'), tm = $('audio-time');
    if (tm) tm.textContent = timeText();
    if (sk && !seeking) { sk.max = Math.max(1, Math.floor(audioDur / 1000)); sk.value = Math.floor(audioPos / 1000); sk.setAttribute('aria-valuetext', spoken()); }
  }
  function onPlayback(e) {
    const d = (e && e.data) || {};
    playerLoaded = true; if (!loadedAt) loadedAt = performance.now();
    audioPos = Number(d.position) || 0; audioDur = Number(d.duration) || 0;
    const was = prevPaused; prevPaused = d.isPaused;
    audioPlaying = d.isPaused === false;
    audioEnded = audioDur > 0 && audioPos >= audioDur - 1000;
    audioStarted = audioPlaying && !d.isBuffering;
    updateAudioUi();
    if (!view || view.you !== view.hostId) return;
    // ignore a late event of the previous track: sound must be fresh (near the start or for the loaded uri)
    const fresh = d.playingURI ? d.playingURI === loadedUri : audioPos < 2000;
    // the round starts when sound starts: our Play click, or the embed's own button in the fallback
    if (audioStarted && fresh && view.phase === 'between' && !playSent && (playClicked || fallback)) {
      playSent = true; fallback = false;
      clearInterval(watchTimer);
      send({ type: 'play' });
      syncEmbed();
    }
    if (view.phase === 'playing') {
      if (performance.now() - lastLocalPauseAt < 1000) return; // echo of our own click
      if (was === false && d.isPaused === true && !audioEnded) sendPause(); // paused by itself, not the end of the track
      else if (was === true && d.isPaused === false) sendResume();
    }
  }
  // blocked (not just slow) = the player loaded but stayed paused 4 s after the click; slow load gets up to 12 s
  function startWatch() {
    clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      if (!view || view.phase !== 'between' || playSent) { clearInterval(watchTimer); return; }
      const now = performance.now();
      if (!playerLoaded) {
        if (now - clickAt > 12000) { clearInterval(watchTimer); slowLoad = true; playClicked = false; render(); }
      } else if (!fallback && now - Math.max(clickAt, loadedAt) > 4000) { fallback = true; render(); }
    }, 500);
  }
  function loadEmbedScript() {
    window.onSpotifyIframeApiReady = (IFrameAPI) => {
      const created = pendingUri || 'spotify:track:0000000000000000000000';
      IFrameAPI.createController($('embed').appendChild(document.createElement('div')),
        { uri: created, width: '100%', height: 80 }, (c) => {
          controller = c; loadedUri = created;
          c.addListener('playback_update', onPlayback);
          c.addListener('ready', () => { playerLoaded = true; if (!loadedAt) loadedAt = performance.now(); });
          if (pendingUri && pendingUri !== created) { c.loadUri(pendingUri); loadedUri = pendingUri; }
          if (view) render();
        });
    };
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.async = true;
    s.onerror = () => { apiFailed = true; if (view) render(); };
    document.head.appendChild(s);
  }
  let embedStarted = false;
  // the ONLY place that shows the embed: during reveal, and as the last-resort fallback in between
  function syncEmbed() {
    if (view.you !== view.hostId) return;
    if (embedPhase !== view.phase) { // new phase: reset the play guards
      embedPhase = view.phase;
      playClicked = playSent = fallback = slowLoad = false;
      clearInterval(watchTimer);
      if (view.phase === 'between' && controller && controller.pause) controller.pause();
    }
    if (view.phase === 'finished' && controller && controller.pause) controller.pause();
    if (!embedStarted) { embedStarted = true; pendingUri = view.nextUri || null; loadEmbedScript(); }
    const show = fallback && view.phase === 'between' && !apiFailed;
    setEmbedVisible(show || (view.phase === 'reveal' && !apiFailed));
    const note = $('embed-note');
    note.hidden = !(apiFailed || show);
    note.textContent = apiFailed
      ? 'Could not load the Spotify player. Check your connection or ad blocker and reload; the game cannot play audio without it.'
      : show ? 'Your browser blocked automatic audio. Tap play on the player below to start the round. It shows the song title: look away, or ask someone else to press play.' : '';
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

  function streakEl(p) {
    if (!(p.streak >= STREAK_MIN)) return null;
    return el('span', { class: 'streak' }, el('span', { 'aria-hidden': 'true', text: '🔥 ' + p.streak }),
      el('span', { class: 'sr-only', text: p.streak + ' in a row' }));
  }
  const nameSpan = (p, extra) => el('span', { class: 'grow' }, tag(p) + extra, streakEl(p));

  // one iframe node per track id, reused so a playing song is never reloaded
  const frames = new Map();
  function spotifyFrame(id, title) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
    let f = frames.get(id);
    if (!f) {
      f = el('iframe', { height: 80, loading: 'lazy', frameBorder: '0',
        allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture' });
      f.style.width = '100%';
      f.src = 'https://open.spotify.com/embed/track/' + id + '?utm_source=generator';
      frames.set(id, f);
    }
    f.title = title;
    return f;
  }

  function refreshScoreboard() {
    const old = $('scoreboard');
    if (old) old.replaceChildren(...scoreboard().childNodes);
  }

  function scoreboard() {
    const sorted = [...view.players].sort((a, b) => b.score - a.score);
    const d = (view.reveal && view.reveal.deltas) || {};
    return el('section', { id: 'scoreboard', class: 'side' }, el('h2', { text: 'Scoreboard' }),
      el('ul', {}, ...sorted.map((p) => el('li', {},
        nameSpan(p, p.id === view.you ? ' (you)' : ''),
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
        nameSpan(p, (p.id === view.hostId ? ' (host)' : '') + (p.id === view.you ? ' (you)' : '')),
        el('span', { class: 'muted', text: p.connected ? '' : 'offline' }))))];
  }

  const bufMax = (p) => (Number.isInteger(p) && p >= 1 ? Math.min(20, p - 1) : 20);
  const settingsSummary = () => {
    const s = view.settings;
    return 'Settings: ' + (s.source === 'liked' ? 'liked songs' : 'recently played') + ', ' + s.perPerson + ' songs each, ' +
      s.buffer + ' removals each, ' + (s.timer === false ? 'no timer' : '20 s timer') + (s.hostPlays ? ', host plays' : ', host only hosts');
  };

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
      const per = el('input', { id: 'f-per', type: 'number', min: 1, max: 25, step: 1, required: true, value: s.perPerson });
      const buffer = el('input', { id: 'f-buffer', type: 'number', min: 0, max: bufMax(s.perPerson), step: 1, required: true, value: s.buffer });
      // lowering songs per person clamps removals to the new max so both can still be sent
      const fixMax = () => {
        const m = bufMax(Number(per.value));
        buffer.max = m;
        if (per.checkValidity() && Number(buffer.value) > m) buffer.value = m;
      };
      per.addEventListener('input', fixMax);
      const nt = el('input', { id: 'f-notimer', type: 'checkbox', checked: s.timer === false });
      const hp = el('input', { id: 'f-hp', type: 'checkbox', checked: s.hostPlays });
      const push = () => {
        fixMax();
        if (!per.checkValidity() || !buffer.checkValidity()) { showError('Songs per person 1-25, removals 0 to songs-1'); return false; }
        showError('');
        send({ type: 'settings', settings: {
          source: source.value, perPerson: Number(per.value), buffer: Number(buffer.value), timer: !nt.checked, hostPlays: hp.checked } });
        return true;
      };
      for (const i of [source, per, buffer, nt, hp]) i.addEventListener('change', push);
      out.push(el('section', { id: 'lobby-settings' }, el('h2', { text: 'Settings' }),
        el('label', { htmlFor: 'f-source', text: 'Song source' }), source,
        el('label', { htmlFor: 'f-per', text: 'Songs per person' }), per,
        el('label', { htmlFor: 'f-buffer', text: 'Removals each' }), buffer,
        el('p', { class: 'muted', text: 'Everyone ends up with (songs per person - removals) songs in the game; if you do not remove enough, random ones are dropped.' }),
        el('label', { htmlFor: 'f-notimer' }, nt, 'No timer'),
        el('p', { class: 'muted', text: 'Rounds end when everyone has guessed or you press Reveal now. Correct guesses score a flat 1000.' }),
        el('label', { htmlFor: 'f-hp' }, hp, 'I play too (host guesses)'),
        btn('Start', () => { if (push()) send({ type: 'start' }); })));
    } else {
      out.push(el('p', { id: 'settings-summary', class: 'muted', text: settingsSummary() }));
      out.push(el('p', { class: 'muted', text: 'Waiting for the host to start…' }));
    }
    return out;
  }

  let reviewLis = new Map();
  function reviewHeader() {
    const left = view.removalsLeft || 0;
    if (!Number.isFinite(view.keep)) return 'Remove up to ' + left + ' songs.';
    return 'You must keep ' + view.keep + ' songs. Remove up to ' + left + ' more (if you do not, we drop the extras at random).';
  }
  function trackLi(t, i) {
    const f = spotifyFrame(t.id, 'Your song ' + (i + 1));
    const b = btn('Remove', () => send({ type: 'remove', trackId: t.id }), 'secondary', 'remove-' + t.id);
    const li = el('li', { class: 'track' }, f || el('span', { text: t.title }), f ? null : el('span', { class: 'muted', text: t.artist }), b);
    reviewLis.set(t.id, { li, b });
    return li;
  }
  // updates the review screen in place so the song iframes are never detached or reloaded
  function syncReview() {
    const tracks = view.myTracks || [];
    const ids = new Set(tracks.map((t) => t.id));
    for (const [id, r] of [...reviewLis]) if (!ids.has(id)) { r.li.remove(); reviewLis.delete(id); }
    const ul = $('review-list');
    tracks.forEach((t, i) => { if (!reviewLis.has(t.id)) ul.append(trackLi(t, i)); });
    const keepN = Number.isFinite(view.keep) ? view.keep : 1;
    const can = (view.removalsLeft || 0) > 0 && tracks.length > keepN;
    for (const r of reviewLis.values()) r.b.disabled = !can;
    $('review-head').textContent = reviewHeader();
    const me = view.players.find((p) => p.id === view.you);
    const n = view.players.filter((p) => p.ready).length + '/' + view.players.length;
    $('review-ready').hidden = !!(me && me.ready);
    $('review-status').textContent = me && me.ready ? 'Ready. Waiting for the others… ' + n : 'Ready: ' + n;
  }

  function review() {
    if (!view.myTracks) return [el('p', { text: 'Waiting for the other players…' })];
    reviewLis = new Map();
    const ready = btn('Ready', () => send({ type: 'ready' }));
    ready.id = 'review-ready';
    pendingReviewSync = true;
    return [el('section', {}, el('h2', { text: 'Your songs' }),
      el('p', { id: 'review-head', class: 'muted' }), el('ul', { id: 'review-list' }), ready,
      el('p', { id: 'review-status', class: 'muted' }))];
  }
  let pendingReviewSync = false;

  function roundHeader() {
    return el('p', { class: 'muted', text: 'Round ' + (view.round.index + 1) + ' of ' + view.round.total });
  }

  // the host's single "Now playing" card: Play (between) or Pause/seek/time (playing); reveal uses the embed itself
  function playCard() {
    const starting = playClicked && !fallback && !playSent;
    const b = btn('', () => {
      if (apiFailed || !controller) { showError('The Spotify player is not ready yet.'); return; }
      // same user gesture: start audio here; the round starts when the embed reports sound
      playClicked = true; fallback = false; playSent = false; slowLoad = false; clickAt = performance.now();
      try { controller.play(); } catch (e) { showError('Could not start the player.'); }
      startWatch();
      render();
    }, 'icon-btn', 'Play');
    setIcon(b, 'play', 'Play');
    b.disabled = starting || apiFailed;
    const seek = el('input', { id: 'between-seek', type: 'range', min: 0, max: 1, step: 1, value: 0, disabled: true, 'aria-label': 'Seek' });
    const msg = apiFailed ? 'The Spotify player failed to load, so audio cannot start. Reload the page or check for an ad blocker.'
      : starting ? 'Starting audio…'
      : slowLoad ? 'Spotify is slow to load. Press Play to try again.' : '';
    return el('section', { id: 'now-playing' }, el('h2', { text: 'Now playing' }),
      el('div', { class: 'music-row' }, b, seek, el('span', { class: 'music-time', text: '0:00 / --:--' })),
      msg ? el('p', { class: 'muted', text: msg }) : null);
  }

  function between() {
    if (isHost()) return [roundHeader(), playCard()];
    return [roundHeader(), el('p', { class: 'big', text: 'Get ready' })];
  }

  let playRound = -1;
  function updCountdown() {
    const cd = $('countdown'), pb = $('paused-badge');
    if (!cd || !view || !view.round) return;
    const r = view.round;
    if (r.timed === false) { cd.textContent = 'No timer'; pb.hidden = true; return; }
    pb.hidden = !r.paused;
    if (r.paused && Number.isFinite(r.remainingMs)) { cd.textContent = Math.ceil(r.remainingMs / 1000) + 's'; return; }
    if (localDeadline === null) { cd.textContent = ''; return; }
    const ms = Math.max(0, localDeadline - performance.now());
    if (ms === 0) { timeUp = true; cd.textContent = 'Time is up'; for (const b of guessBtns) b.disabled = true; }
    else cd.textContent = Math.ceil(ms / 1000) + 's';
  }

  function hostControls() {
    const call = (n, ...a) => { if (typeof controller[n] === 'function') { controller[n](...a); return true; } return false; };
    const toggle = btn('', () => {
      lastLocalPauseAt = performance.now();
      if (audioEnded) { call('seek', 0); call('resume') || call('togglePlay'); sendResume(); } // replay; never a round start
      else if (audioPlaying) { call('pause') || call('togglePlay'); sendPause(); } else { call('resume') || call('togglePlay'); sendResume(); }
    }, 'icon-btn', 'audio-toggle');
    toggle.id = 'audio-toggle';
    setIcon(toggle, toggleKind()[0], toggleKind()[1]);
    const seek = el('input', { id: 'audio-seek', type: 'range', min: 0, max: Math.max(1, Math.floor(audioDur / 1000)), step: 1, value: Math.floor(audioPos / 1000), 'aria-label': 'Seek' });
    seek.setAttribute('aria-valuetext', spoken());
    seek.addEventListener('input', () => { seeking = true; });
    seek.addEventListener('change', () => { seeking = false; call('seek', Number(seek.value)); });
    return [el('div', { class: 'music-row' }, toggle, seek, el('span', { id: 'audio-time', class: 'music-time', text: timeText() }))];
  }

  // updates only what changed; the host's slider/toggle nodes and a seek drag survive broadcasts
  function syncPlaying() {
    const hc = $('host-controls');
    if (hc && controller && !hc.firstChild) hc.append(...hostControls());
    updateAudioUi();
    const slot = $('play-slot');
    const iAmGuesser = view.settings.hostPlays || !isHost();
    const opts = view.players.filter((p) => !(p.id === view.you || (!view.settings.hostPlays && p.id === view.hostId)));
    const variant = !iAmGuesser ? 'host' : view.iOwnThisSong ? 'owner' : view.myGuess ? 'locked' : 'guess';
    const sig = variant + (variant === 'guess' ? ':' + opts.map((p) => p.id + '=' + tag(p)).join(',') : '');
    if (slot.dataset.sig !== sig) {
      slot.dataset.sig = sig;
      guessBtns = [];
      if (variant === 'host') {
        slot.replaceChildren(el('p', { text: 'Hosting' }), el('p', { id: 'guessed-count', class: 'muted' }));
      } else if (variant === 'owner') {
        slot.replaceChildren(el('p', { text: 'This one is yours! Sit this round out while the others guess.' }));
      } else if (variant === 'locked') {
        slot.replaceChildren(el('p', { class: 'big', text: 'Locked in' }));
      } else {
        const grid = el('div', { class: 'guess-grid' });
        for (const p of opts) {
          const b = btn(tag(p), () => { guessPending = true; for (const x of guessBtns) x.disabled = true; send({ type: 'guess', playerId: p.id }); }, '', 'guess-' + p.id);
          guessBtns.push(b);
          grid.append(b);
        }
        slot.replaceChildren(el('h2', { text: 'Whose song is this?' }), grid);
      }
    }
    if (variant === 'guess') for (const b of guessBtns) b.disabled = guessPending || timeUp;
    const gc = $('guessed-count');
    if (gc) gc.textContent = 'Guessed: ' + view.round.guessedCount;
  }

  function playing() {
    const out = [roundHeader(), el('div', { class: 'cd-row' }, el('p', { class: 'big', id: 'countdown' }), el('span', { id: 'paused-badge', text: 'Paused', hidden: true }))];
    timeUp = false; guessBtns = []; seeking = false; revealClicked = false; playRound = view.round.index;
    if (isHost()) {
      const card = el('section', { id: 'now-playing' }, el('h2', { text: 'Now playing' }), el('div', { id: 'host-controls' }));
      if (timed()) card.append(el('p', { class: 'muted', text: 'Pausing also pauses the round timer.' }));
      else {
        const rb = btn('Reveal now', () => { if (revealClicked) return; revealClicked = true; rb.disabled = true; send({ type: 'reveal' }); }, '', 'reveal-now');
        rb.id = 'reveal-btn';
        card.append(rb, el('p', { class: 'muted', text: 'No timer: pausing only pauses the music.' }));
      }
      out.push(card);
    }
    out.push(el('div', { id: 'play-slot' }), scoreboard());
    pendingPlaySync = true;
    tick = setInterval(updCountdown, 250);
    return out;
  }
  let pendingPlaySync = false;

  let prevStreak = 0, streakRound = -1, streakLost = false;
  function reveal() {
    const r = view.reveal;
    const pts = r.deltas[view.you] || 0;
    const me = view.players.find((p) => p.id === view.you) || {};
    const mine = me.streak || 0;
    if (streakRound !== view.round.index) { streakLost = prevStreak >= STREAK_MIN && mine === 0; prevStreak = mine; streakRound = view.round.index; }
    const card = el('section', { id: 'reveal-card' }, el('h2', { text: 'It was ' + nameOf(r.ownerId) + '’s song' }));
    card.dataset.round = String(view.round.index);
    // the host listens through the visible host embed (unless it failed to load); everyone else gets a slim player
    const f = !isHost() || apiFailed ? spotifyFrame(r.track.id, 'Revealed song') : null;
    if (f) card.append(f);
    card.append(el('p', { text: view.myGuess ? (view.myGuess === r.ownerId ? 'You got it! +' + pts : 'Wrong guess, +0') : 'No guess, +0' }));
    if (mine >= STREAK_MIN) card.append(el('p', {}, streakEl(me)));
    else if (streakLost) card.append(el('p', { class: 'muted', text: 'Streak lost' }));
    const out = [roundHeader(), card, scoreboard()];
    if (isHost()) out.push(btn('Next', () => send({ type: 'next' }), 'foot', 'Next'));
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

  // three persistent containers in #stage: main, foot (Next button), side; DOM order = visual order everywhere,
  // the desktop two-column layout comes from CSS grid areas
  function mount(kids) {
    const m = [], f = [], sd = [];
    for (const k of kids) (k.classList.contains('side') ? sd : k.classList.contains('foot') ? f : m).push(k);
    app.replaceChildren(...m); appFoot.replaceChildren(...f); appSide.replaceChildren(...sd);
  }

  function render() {
    if (view.phase === 'review' && lastPhase === 'review' && $('review-list')) {
      syncReview();
    } else if (view.phase === 'playing' && lastPhase === 'playing' && playRound === view.round.index && $('play-slot')) {
      syncPlaying(); refreshScoreboard(); updCountdown();
    } else if (view.phase === 'reveal' && lastPhase === 'reveal' && $('reveal-card') && $('reveal-card').dataset.round === String(view.round.index)) {
      refreshScoreboard();
    } else if (view.phase === 'lobby' && lastPhase === 'lobby' && $('lobby-players')) {
      // keep the settings form (typing, focus) intact; only refresh the player list and idle fields
      $('lobby-players').replaceChildren(...lobbyPlayers());
      syncBots();
      syncQr();
      const set = (id, v) => { const f = $(id); if (f && document.activeElement !== f) f[typeof v === 'boolean' ? 'checked' : 'value'] = v; };
      set('f-source', view.settings.source); set('f-per', view.settings.perPerson);
      set('f-buffer', view.settings.buffer);
      if ($('f-buffer') && document.activeElement !== $('f-per')) $('f-buffer').max = bufMax(view.settings.perPerson);
      set('f-notimer', view.settings.timer === false);
      set('f-hp', view.settings.hostPlays);
      if ($('settings-summary')) $('settings-summary').textContent = settingsSummary();
    } else {
      clearInterval(tick);
      const a = document.activeElement;
      const fk = a && a.dataset ? a.dataset.focus || a.id : null;
      const f = phases[view.phase];
      mount(f ? f() : [el('p', { text: 'Unknown state' })]);
      if (pendingReviewSync) { pendingReviewSync = false; syncReview(); }
      if (pendingPlaySync) { pendingPlaySync = false; syncPlaying(); updCountdown(); }
      if (fk) {
        const t = [...$('stage').querySelectorAll('[data-focus],[id]')].find((x) => (x.dataset.focus || x.id) === fk);
        if (t) t.focus();
      }
    }
    if (view.phase === 'lobby') { syncBots(); syncQr(); }
    lastPhase = view.phase;
    devBanner();
    syncEmbed();
  }

  if (!key) {
    mount([el('div', { class: 'terminal' }, el('p', { text: 'No session.' }),
      el('a', { class: 'btn secondary', href: '/', text: 'Home page' }))]);
  } else connect();
})();

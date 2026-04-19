// Content script: reads FEN from chess.com / lichess, shows analysis overlay

(function () {
  'use strict';

  // Guard against double-injection (SPA reloads, dev refreshes, etc.)
  if (window.__chessAnalyzerLoaded) return;
  window.__chessAnalyzerLoaded = true;

  const PANEL_ID = 'chess-analyzer-panel';
  let currentFen = null;
  let highlights = [];
  let boardFlipped = false;
  let analysisGen = 0; // monotonic counter so late retries can't overwrite newer analyses
  let hlEnabled = true;
  let userColorOverride = null; // null = auto-detect, 'w' or 'b' = manual override
  let showRiskyChecks = false; // when false, hide checks that lose material

  // ── FEN extraction ─────────────────────────────────────────────────────────

  // Read pieces rendered in lichess's chessground DOM → FEN string
  function fenFromChessgroundDOM() {
    const board = document.querySelector('cg-board');
    if (!board) return null;
    // If anything is mid-animation or being dragged, the snapshot is unreliable.
    if (board.querySelector('piece.anim, piece.dragging, piece.fading')) return null;
    const pieces = board.querySelectorAll('piece');
    if (!pieces.length) return null;

    const boardRect = board.getBoundingClientRect();
    if (!boardRect.width) return null;
    const sqW = boardRect.width / 8;
    const sqH = boardRect.height / 8;
    const isFlipped = isBoardFlipped();
    const grid = new Array(64).fill(null);

    const roleMap = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };

    for (const piece of pieces) {
      const rect = piece.getBoundingClientRect();
      const cx = rect.left + rect.width / 2 - boardRect.left;
      const cy = rect.top + rect.height / 2 - boardRect.top;
      let file = Math.floor(cx / sqW);
      let rank = 7 - Math.floor(cy / sqH);
      if (isFlipped) { file = 7 - file; rank = 7 - rank; }
      if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;

      const cls = [...piece.classList];
      const color = cls.includes('white') ? 'w' : 'b';
      const type = roleMap[cls.find(c => roleMap[c])] || null;
      if (type) grid[rank * 8 + file] = { type, color };
    }

    // Build FEN board part
    let fen = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = grid[r * 8 + f];
        if (!p) { empty++; }
        else {
          if (empty) { fen += empty; empty = 0; }
          fen += p.color === 'w' ? p.type.toUpperCase() : p.type;
        }
      }
      if (empty) fen += empty;
      if (r > 0) fen += '/';
    }

    // Guess active color from whose clock is ticking
    let activeColor = 'w';
    const activeClock = document.querySelector('.rclock.rclock-turn');
    if (activeClock) {
      activeColor = activeClock.classList.contains('rclock-top') ? 'b' : 'w';
      if (isFlipped) activeColor = activeColor === 'w' ? 'b' : 'w';
    }

    return fen + ` ${activeColor} - - 0 1`;
  }

  // Read pieces from chess.com's rendered piece divs → FEN string
  // Chess.com gives every piece a class like `square-XY` where X=file(1-8), Y=rank(1-8).
  // This is far more reliable than measuring pixel positions during animations.
  function fenFromChessComDOM() {
    const board = document.querySelector('wc-chess-board') ||
                  document.querySelector('chess-board') ||
                  document.querySelector('.board-layout-chessboard') ||
                  document.querySelector('.board');
    if (!board) return null;
    const pieces = board.querySelectorAll('.piece');
    if (!pieces.length) return null;

    const grid = new Array(64).fill(null);

    for (const piece of pieces) {
      const cls = [...piece.classList];
      const pieceCls = cls.find(c => /^[wb][pnbrqk]$/.test(c));
      const sqCls = cls.find(c => /^square-\d{2}$/.test(c));
      if (!pieceCls || !sqCls) continue;

      const color = pieceCls[0];
      const type = pieceCls[1];
      const file = parseInt(sqCls[7]) - 1;  // square-XY: X=file 1..8 → 0..7
      const rank = parseInt(sqCls[8]) - 1;  // Y=rank 1..8 → 0..7
      if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;

      grid[rank * 8 + file] = { type, color };
    }

    let fen = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = grid[r * 8 + f];
        if (!p) { empty++; }
        else {
          if (empty) { fen += empty; empty = 0; }
          fen += p.color === 'w' ? p.type.toUpperCase() : p.type;
        }
      }
      if (empty) fen += empty;
      if (r > 0) fen += '/';
    }
    return fen + ' w - - 0 1';
  }

  function getFenFromPage() {
    const host = location.hostname;

    if (host.includes('chess.com')) {
      const cb = document.querySelector('wc-chess-board') ||
                 document.querySelector('chess-board');
      if (cb) {
        const fen = cb.getAttribute('fen') || cb.fen;
        if (fen && fen.includes('/')) return fen;
      }
      return fenFromChessComDOM();
    }

    if (host.includes('lichess.org')) {
      const el = document.querySelector('[data-fen]');
      if (el) return el.getAttribute('data-fen');
      try {
        const fen = window.lichess?.analysis?.node?.fen ||
                    window.lichess?.puzzle?.data?.game?.fen;
        if (fen) return fen;
      } catch (_) {}
      // Fall back to reading pieces from the rendered board
      return fenFromChessgroundDOM();
    }

    return null;
  }

  // Source of truth: where is the white king actually rendered on screen?
  // If it's in the visual top half of the board, the board is flipped (we're black).
  // Both chess.com and lichess use CSS to render flipped boards — the piece's
  // "square-XY" class on chess.com is the LOGICAL position, not the visual one,
  // so we must measure pixel position via getBoundingClientRect.
  function detectOrientationFromPieces() {
    const board = document.querySelector('cg-board') ||
                  document.querySelector('wc-chess-board') ||
                  document.querySelector('chess-board');
    if (!board) return null;

    const boardRect = board.getBoundingClientRect();
    if (!boardRect.height) return null;

    // Chess.com: <div class="piece wk square-XY">
    // Lichess:   <piece class="white king ...">
    const king = board.querySelector('.piece.wk') ||
                 board.querySelector('piece.white.king');
    if (!king) return null;

    const rect = king.getBoundingClientRect();
    const cy = rect.top + rect.height / 2 - boardRect.top;
    return cy < boardRect.height / 2; // white king in top half → flipped
  }

  function isBoardFlipped() {
    const fromPieces = detectOrientationFromPieces();
    if (fromPieces !== null) return fromPieces;

    // Fallback: CSS classes (only if pieces aren't readable yet)
    const host = location.hostname;
    if (host.includes('chess.com')) {
      const cb = document.querySelector('wc-chess-board') ||
                 document.querySelector('chess-board');
      return cb?.classList.contains('flipped') ||
             cb?.getAttribute('orientation') === 'black' || false;
    }
    if (host.includes('lichess.org')) {
      const board = document.querySelector('cg-board');
      const wrap = board?.closest('.cg-wrap');
      return !!wrap?.classList.contains('orientation-black');
    }
    return false;
  }

  // ── Board highlighting ─────────────────────────────────────────────────────

  function clearHighlights() {
    document.querySelectorAll('.ca-highlight').forEach(el => el.remove());
    highlights = [];
  }

  function getBoardElement() {
    return document.querySelector('wc-chess-board') ||
           document.querySelector('chess-board') ||
           document.querySelector('cg-board') ||
           document.querySelector('.cg-wrap');
  }

  function getSquareSize(boardEl) {
    const rect = boardEl.getBoundingClientRect();
    return { w: rect.width / 8, h: rect.height / 8, rect };
  }

  function squareToPosition(sq, boardEl) {
    const { w, h, rect } = getSquareSize(boardEl);
    const file = 'abcdefgh'.indexOf(sq[0]);
    const rank = parseInt(sq[1]) - 1;
    const flipped = isBoardFlipped();

    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;

    return {
      left: rect.left + window.scrollX + col * w,
      top: rect.top + window.scrollY + row * h,
      width: w,
      height: h
    };
  }

  function addHighlight(square, color, label) {
    const boardEl = getBoardElement();
    if (!boardEl) return;
    const pos = squareToPosition(square, boardEl);
    const div = document.createElement('div');
    div.className = 'ca-highlight';
    div.style.cssText = `
      position: absolute;
      left: ${pos.left}px;
      top: ${pos.top}px;
      width: ${pos.width}px;
      height: ${pos.height}px;
      background: ${color};
      pointer-events: none;
      z-index: 9998;
      border-radius: 2px;
      box-sizing: border-box;
    `;
    if (label) {
      div.title = label;
    }
    document.body.appendChild(div);
    highlights.push(div);
  }

  function addDotMarker(square, color, label) {
    const boardEl = getBoardElement();
    if (!boardEl) return;
    const pos = squareToPosition(square, boardEl);
    const dotSize = Math.round(pos.width * 0.25);
    const div = document.createElement('div');
    div.className = 'ca-highlight';
    div.style.cssText = `
      position: absolute;
      left: ${pos.left + (pos.width - dotSize) / 2}px;
      top: ${pos.top + (pos.height - dotSize) / 2}px;
      width: ${dotSize}px;
      height: ${dotSize}px;
      background: ${color};
      pointer-events: none;
      z-index: 9999;
      border-radius: 50%;
      box-sizing: border-box;
    `;
    if (label) div.title = label;
    document.body.appendChild(div);
    highlights.push(div);
  }

  function highlightResults(result) {
    if (!getBoardElement()) return;
    clearHighlights();

    // Red: my pieces that can be taken in an uneven trade
    for (const h of result.hanging.ours) {
      addHighlight(h.square, 'rgba(220, 50, 50, 0.55)',
        `⚠ ${h.pieceName} — ${h.defended ? 'can be traded down' : 'undefended'}`);
    }

    // Green: opponent pieces I can take favorably
    for (const h of result.hanging.theirs) {
      addHighlight(h.square, 'rgba(50, 200, 80, 0.50)',
        `✓ ${h.pieceName} — favorable capture`);
    }

    // Green dot on opponent king + green dots on pieces that can deliver check
    const visibleChecks = filterChecks(result.checks);
    if (visibleChecks.length && result.opponentKingSquare) {
      addDotMarker(result.opponentKingSquare, 'rgba(50, 200, 80, 0.9)',
        '♚ Check available!');

      const seen = new Set();
      for (const c of visibleChecks) {
        if (seen.has(c.from)) continue;
        seen.add(c.from);
        addDotMarker(c.from, 'rgba(50, 200, 80, 0.9)',
          `${c.pieceName} can give check${c.safe ? '' : ' (sacrifice)'}`);
      }
    }

    // Red dot on my king if opponent can check me (apply same risky filter)
    const visibleOppChecks = filterChecks(result.oppChecks || []);
    if (visibleOppChecks.length && result.myKingSquare) {
      addDotMarker(result.myKingSquare, 'rgba(220, 50, 50, 0.9)',
        '♚ Opponent can check you!');
    }
  }

  function filterChecks(checks) {
    if (!checks) return [];
    return showRiskyChecks ? checks : checks.filter(c => c.safe);
  }

  // ── Panel UI ───────────────────────────────────────────────────────────────

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="ca-header">
        <span>♟ BlunderChecker</span>
        <div class="ca-controls">
          <button class="ca-btn" id="ca-color" title="Your color (click to cycle: Auto → W → B → Auto)">Auto:W</button>
          <button class="ca-btn" id="ca-risky" title="Show risky checks (sacrifices)">!</button>
          <button class="ca-btn" id="ca-toggle-hl" title="Toggle analysis (re-reads position)">◉</button>
          <button class="ca-btn ca-close" id="ca-close">✕</button>
        </div>
      </div>
      <div class="ca-fen-row">
        <input id="ca-fen-input" type="text" placeholder="Paste FEN here…" spellcheck="false" />
        <button class="ca-btn" id="ca-analyze">Analyze</button>
      </div>
      <div id="ca-results"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('ca-close').addEventListener('click', () => {
      panel.style.display = 'none';
      clearHighlights();
    });
    document.getElementById('ca-analyze').addEventListener('click', () => {
      const fen = document.getElementById('ca-fen-input').value.trim();
      if (fen) runAnalysis(fen);
    });

    document.getElementById('ca-color').addEventListener('click', () => {
      if (userColorOverride === null) userColorOverride = 'w';
      else if (userColorOverride === 'w') userColorOverride = 'b';
      else userColorOverride = null;
      updateColorButton();
      clearHighlights();
      refreshAnalysis(true);
    });

    document.getElementById('ca-risky').addEventListener('click', () => {
      showRiskyChecks = !showRiskyChecks;
      document.getElementById('ca-risky').style.opacity = showRiskyChecks ? '1' : '0.4';
      clearHighlights();
      refreshAnalysis(true);
    });
    // Initial dimmed state — risky checks hidden by default
    document.getElementById('ca-risky').style.opacity = '0.4';

    document.getElementById('ca-toggle-hl').addEventListener('click', () => {
      hlEnabled = !hlEnabled;
      const btn = document.getElementById('ca-toggle-hl');
      btn.style.opacity = hlEnabled ? '1' : '0.4';
      if (hlEnabled) {
        clearHighlights();
        refreshAnalysis(true);
      } else {
        clearHighlights();
      }
    });

    document.getElementById('ca-fen-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('ca-analyze').click();
    });

    makeDraggable(panel);
    return panel;
  }

  function makeDraggable(el) {
    const header = el.querySelector('.ca-header');
    let dragging = false, ox = 0, oy = 0;
    header.addEventListener('mousedown', e => {
      if (e.target.classList.contains('ca-btn')) return;
      dragging = true;
      ox = e.clientX - el.getBoundingClientRect().left;
      oy = e.clientY - el.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      el.style.left = (e.clientX - ox) + 'px';
      el.style.top = (e.clientY - oy) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function setResults(html) {
    document.getElementById('ca-results').innerHTML = html;
  }

  function renderResults(result) {
    if (result.error) {
      setResults(`<p class="ca-error">${result.error}</p>`);
      return;
    }

    const userName = result.userColor === 'w' ? 'White' : 'Black';
    const turnText = result.isYourTurn ? 'your move' : "opponent's move";
    let html = `<p class="ca-turn">You: <strong>${userName}</strong> · ${turnText}</p>`;

    const { ours, theirs } = result.hanging;

    html += '<div class="ca-section">';
    html += '<div class="ca-section-title ca-red">⚠ Your pieces at risk</div>';
    if (ours.length === 0) {
      html += '<p class="ca-empty">No pieces at risk</p>';
    } else {
      for (const h of ours) {
        const atk = h.attackers.map(a => a.name).join(', ');
        const reason = h.defended ? 'trade-down possible' : 'undefended';
        html += `<div class="ca-item ca-item-red">
          <span class="ca-sq">${h.square}</span>
          <span>${h.pieceName} · ${atk} attacks · ${reason}</span>
        </div>`;
      }
    }
    html += '</div>';

    const visibleChecks = filterChecks(result.checks);
    html += '<div class="ca-section">';
    html += '<div class="ca-section-title ca-green">✓ Good captures available</div>';
    if (theirs.length === 0 && visibleChecks.length === 0) {
      html += '<p class="ca-empty">No good captures or checks</p>';
    } else {
      for (const h of theirs) {
        const atk = h.attackers.map(a => a.name).join(', ');
        html += `<div class="ca-item ca-item-green">
          <span class="ca-sq">${h.square}</span>
          <span>${h.pieceName} · take with ${atk}</span>
        </div>`;
      }
      if (visibleChecks.length) {
        const pieces = [...new Set(visibleChecks.map(c => c.pieceName))].join(', ');
        const hidden = result.checks.length - visibleChecks.length;
        const note = hidden > 0 ? ` (${hidden} risky hidden)` : '';
        html += `<div class="ca-item ca-item-green">
          <span class="ca-sq">${result.opponentKingSquare}</span>
          <span>King · check available via ${pieces}${note}</span>
        </div>`;
      }
    }
    html += '</div>';

    html += '<p class="ca-note"><span style="color:#e05050">■</span> your piece at risk &nbsp;' +
            '<span style="color:#3cc860">■</span> good capture / check</p>';

    setResults(html);
  }

  function getAutoUserColor() {
    return isBoardFlipped() ? 'b' : 'w';
  }

  function getUserColor() {
    return userColorOverride || getAutoUserColor();
  }

  function updateColorButton() {
    const btn = document.getElementById('ca-color');
    if (!btn) return;
    const auto = getAutoUserColor();
    if (userColorOverride === null) {
      btn.textContent = 'Auto:' + auto.toUpperCase();
      btn.style.opacity = '0.7';
    } else {
      btn.textContent = userColorOverride.toUpperCase();
      btn.style.opacity = '1';
    }
  }

  function runAnalysis(fen) {
    currentFen = fen;
    const myGen = ++analysisGen;
    const result = window.ChessAnalyzer.analyzePosition(fen, getUserColor());
    // If a newer analysis kicked off in between (shouldn't happen sync, but be safe), bail.
    if (myGen !== analysisGen) return;
    renderResults(result);
    updateColorButton();
    if (!result.error && hlEnabled) highlightResults(result);
  }

  // Try to read a stable FEN. If pieces are mid-animation, fenFromChessgroundDOM
  // returns null — retry up to ~2.5s. `force` ignores the cached currentFen so a
  // toggle-on always redraws even if the position hasn't changed.
  function refreshAnalysis(force = false, attempts = 0) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || panel.style.display === 'none') return;
    const fen = getFenFromPage();
    if (fen) {
      if (force || fen !== currentFen) {
        const input = document.getElementById('ca-fen-input');
        if (input) input.value = fen;
        runAnalysis(fen);
      }
      return;
    }
    if (attempts < 12) {
      setTimeout(() => refreshAnalysis(force, attempts + 1), 200);
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  let pollTimer = null;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      const p = document.getElementById(PANEL_ID);
      if (!p || p.style.display === 'none') return;
      refreshAnalysis(true);
    }, 500);
  }

  function init() {
    createPanel();

    setResults('<p class="ca-warn">Reading position…</p>');
    refreshAnalysis(true);
    startPolling();
  }

  // Expose toggle for popup. When opening, always re-read the current position
  // and retry until animations settle so we never display a stale snapshot.
  window.__chessAnalyzerToggle = function () {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      init();
      return;
    }
    if (panel.style.display === 'none') {
      panel.style.display = '';
      clearHighlights();
      // Wait one frame so the panel's layout settles before we measure squares
      requestAnimationFrame(() => refreshAnalysis(true));
    } else {
      panel.style.display = 'none';
      clearHighlights();
    }
  };

  // Auto-init on chess sites
  init();
})();

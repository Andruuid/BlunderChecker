// Chess analysis logic: hanging pieces and possible checks

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const PIECE_NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
const FILES = 'abcdefgh';

function idxToSq(idx) {
  return FILES[idx % 8] + (Math.floor(idx / 8) + 1);
}

function sqToIdx(sq) {
  return (parseInt(sq[1]) - 1) * 8 + FILES.indexOf(sq[0]);
}

function parseFEN(fen) {
  const parts = fen.trim().split(/\s+/);
  const board = new Array(64).fill(null);
  let rank = 7, file = 0;
  for (const ch of parts[0]) {
    if (ch === '/') { rank--; file = 0; }
    else if (ch >= '1' && ch <= '8') { file += parseInt(ch); }
    else {
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      board[rank * 8 + file] = { type: ch.toLowerCase(), color };
      file++;
    }
  }
  return {
    board,
    activeColor: parts[1] || 'w',
    enPassant: parts[3] !== '-' && parts[3] ? sqToIdx(parts[3]) : -1
  };
}

function getAttackedSquares(board, idx, enPassant) {
  const piece = board[idx];
  if (!piece) return [];
  const { type, color } = piece;
  const rank = Math.floor(idx / 8);
  const file = idx % 8;
  const result = [];

  const push = (r, f) => {
    if (r >= 0 && r < 8 && f >= 0 && f < 8) result.push(r * 8 + f);
  };

  const slide = (dirs) => {
    for (const [dr, df] of dirs) {
      let r = rank + dr, f = file + df;
      while (r >= 0 && r < 8 && f >= 0 && f < 8) {
        result.push(r * 8 + f);
        if (board[r * 8 + f]) break;
        r += dr; f += df;
      }
    }
  };

  switch (type) {
    case 'p': {
      const dir = color === 'w' ? 1 : -1;
      push(rank + dir, file - 1);
      push(rank + dir, file + 1);
      break;
    }
    case 'n':
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
        push(rank + dr, file + df);
      break;
    case 'b': slide([[-1,-1],[-1,1],[1,-1],[1,1]]); break;
    case 'r': slide([[-1,0],[1,0],[0,-1],[0,1]]); break;
    case 'q': slide([[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]); break;
    case 'k':
      for (const [dr, df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])
        push(rank + dr, file + df);
      break;
  }
  return result;
}

function getPieceMoves(board, idx, enPassant) {
  const piece = board[idx];
  if (!piece) return [];
  const { type, color } = piece;
  const rank = Math.floor(idx / 8);
  const file = idx % 8;
  const result = [];
  const opp = color === 'w' ? 'b' : 'w';

  const pushCapOrEmpty = (r, f) => {
    if (r < 0 || r >= 8 || f < 0 || f >= 8) return;
    const target = board[r * 8 + f];
    if (!target || target.color === opp) result.push(r * 8 + f);
  };

  const slide = (dirs) => {
    for (const [dr, df] of dirs) {
      let r = rank + dr, f = file + df;
      while (r >= 0 && r < 8 && f >= 0 && f < 8) {
        const target = board[r * 8 + f];
        if (target) {
          if (target.color === opp) result.push(r * 8 + f);
          break;
        }
        result.push(r * 8 + f);
        r += dr; f += df;
      }
    }
  };

  switch (type) {
    case 'p': {
      const dir = color === 'w' ? 1 : -1;
      const startRank = color === 'w' ? 1 : 6;
      // Forward
      if (!board[(rank + dir) * 8 + file]) {
        result.push((rank + dir) * 8 + file);
        if (rank === startRank && !board[(rank + dir * 2) * 8 + file])
          result.push((rank + dir * 2) * 8 + file);
      }
      // Captures
      for (const df of [-1, 1]) {
        const nr = rank + dir, nf = file + df;
        if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
          const target = board[nr * 8 + nf];
          if (target && target.color === opp) result.push(nr * 8 + nf);
          // En passant
          if (enPassant !== -1 && nr * 8 + nf === enPassant) result.push(nr * 8 + nf);
        }
      }
      break;
    }
    case 'n':
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
        pushCapOrEmpty(rank + dr, file + df);
      break;
    case 'b': slide([[-1,-1],[-1,1],[1,-1],[1,1]]); break;
    case 'r': slide([[-1,0],[1,0],[0,-1],[0,1]]); break;
    case 'q': slide([[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]); break;
    case 'k':
      for (const [dr, df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])
        pushCapOrEmpty(rank + dr, file + df);
      break;
  }
  return result;
}

function isAttackedBy(board, square, byColor, enPassant) {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.color !== byColor) continue;
    if (getAttackedSquares(board, i, enPassant).includes(square)) return true;
  }
  return false;
}

function findHangingPieces(board, activeColor, enPassant) {
  const results = { ours: [], theirs: [] };

  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (!piece || piece.type === 'k') continue;

    const opp = piece.color === 'w' ? 'b' : 'w';
    const attackers = [];
    const defenders = [];

    for (let j = 0; j < 64; j++) {
      const p = board[j];
      if (!p) continue;
      if (getAttackedSquares(board, j, enPassant).includes(i)) {
        if (p.color === opp) attackers.push({ idx: j, piece: p });
        else defenders.push({ idx: j, piece: p });
      }
    }

    if (attackers.length === 0) continue;

    const minAttacker = Math.min(...attackers.map(a => PIECE_VALUES[a.piece.type]));
    const minDefender = defenders.length > 0
      ? Math.min(...defenders.map(d => PIECE_VALUES[d.piece.type]))
      : Infinity;
    const pieceVal = PIECE_VALUES[piece.type];

    // Hanging if: undefended, OR attacker can trade up
    const isHanging = defenders.length === 0 || minAttacker < pieceVal;

    if (isHanging) {
      const entry = {
        square: idxToSq(i),
        squareIdx: i,
        piece,
        pieceName: PIECE_NAMES[piece.type],
        attackers: attackers.map(a => ({ square: idxToSq(a.idx), name: PIECE_NAMES[a.piece.type] })),
        defended: defenders.length > 0
      };
      if (piece.color === activeColor) results.ours.push(entry);
      else results.theirs.push(entry);
    }
  }

  return results;
}

function findPossibleChecks(board, activeColor, enPassant) {
  const oppColor = activeColor === 'w' ? 'b' : 'w';
  const kingIdx = board.findIndex(p => p && p.type === 'k' && p.color === oppColor);
  if (kingIdx === -1) return [];

  // If the king is already in check, don't look for new checks —
  // almost every move would "maintain" the existing check, flooding the UI.
  if (isAttackedBy(board, kingIdx, activeColor, enPassant)) return [];

  const checks = [];

  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (!piece || piece.color !== activeColor) continue;

    const moves = getPieceMoves(board, from, enPassant);
    for (const to of moves) {
      const newBoard = board.slice();
      newBoard[to] = { ...piece };
      newBoard[from] = null;

      // Handle en passant capture removal
      if (piece.type === 'p' && to === enPassant) {
        const capturedPawnIdx = to + (activeColor === 'w' ? -8 : 8);
        newBoard[capturedPawnIdx] = null;
      }

      // Opponent king doesn't move on our turn; kingIdx stays put.
      // (A king can never directly deliver check — only discover one — so
      //  we don't need to track our own king's destination here.)
      if (isAttackedBy(newBoard, kingIdx, activeColor, -1)) {
        checks.push({
          from: idxToSq(from),
          fromIdx: from,
          to: idxToSq(to),
          toIdx: to,
          piece,
          pieceName: PIECE_NAMES[piece.type]
        });
      }
    }
  }

  return checks;
}

// userColor = 'w' or 'b' — the side YOU are playing (bottom of the board).
// Everything in the result is from your perspective, regardless of whose turn it is.
function analyzePosition(fen, userColor) {
  try {
    const { board, activeColor, enPassant } = parseFEN(fen);
    const hanging = findHangingPieces(board, userColor, enPassant);
    const checks = findPossibleChecks(board, userColor, enPassant);
    const oppColor = userColor === 'w' ? 'b' : 'w';
    const oppChecks = findPossibleChecks(board, oppColor, enPassant);
    const kingIdx = board.findIndex(p => p && p.type === 'k' && p.color === oppColor);
    const opponentKingSquare = kingIdx !== -1 ? idxToSq(kingIdx) : null;
    const myKingIdx = board.findIndex(p => p && p.type === 'k' && p.color === userColor);
    const myKingSquare = myKingIdx !== -1 ? idxToSq(myKingIdx) : null;
    return {
      hanging, checks, oppChecks, activeColor, userColor,
      isYourTurn: activeColor === userColor,
      opponentKingSquare, myKingSquare,
      hasChecks: checks.length > 0,
      hasOppChecks: oppChecks.length > 0,
      error: null
    };
  } catch (e) {
    return { error: 'Invalid FEN: ' + e.message };
  }
}

// Export for content script
if (typeof window !== 'undefined') {
  window.ChessAnalyzer = { analyzePosition, parseFEN, idxToSq };
}

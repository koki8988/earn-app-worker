// =====================================================================
// games.js — منطق الألعاب الخالص (دوال نقية، بدون أي I/O)
// =====================================================================

// ---------- XO ----------
const XO_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

export function xoWinner(board) {
  for (const [a, b, c] of XO_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

export function xoAiMove(board) {
  const empties = board.map((v, i) => (v ? null : i)).filter((i) => i !== null);
  const tryMove = (symbol) => {
    for (const i of empties) {
      const copy = [...board]; copy[i] = symbol;
      if (xoWinner(copy) === symbol) return i;
    }
    return null;
  };
  return tryMove("O") ?? tryMove("X") ?? (board[4] === "" ? 4 : null) ??
    [0, 2, 6, 8].find((i) => board[i] === "") ?? empties[Math.floor(Math.random() * empties.length)];
}

// ---------- أربع في صف ----------
export const C4_ROWS = 6, C4_COLS = 7;

export function c4Winner(board) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c < C4_COLS; c++) {
      const v = board[r][c];
      if (!v) continue;
      for (const [dr, dc] of dirs) {
        let count = 1;
        for (let k = 1; k < 4; k++) {
          const nr = r + dr * k, nc = c + dc * k;
          if (nr < 0 || nr >= C4_ROWS || nc < 0 || nc >= C4_COLS || board[nr][nc] !== v) break;
          count++;
        }
        if (count >= 4) return v;
      }
    }
  }
  return null;
}

export function c4Drop(board, col, color) {
  for (let r = C4_ROWS - 1; r >= 0; r--) {
    if (!board[r][col]) { board[r][col] = color; return r; }
  }
  return -1;
}

export function c4AiMove(board) {
  const validCols = [...Array(C4_COLS).keys()].filter((c) => !board[0][c]);
  for (const c of validCols) {
    const copy = board.map((row) => [...row]);
    c4Drop(copy, c, "yellow");
    if (c4Winner(copy) === "yellow") return c;
  }
  for (const c of validCols) {
    const copy = board.map((row) => [...row]);
    c4Drop(copy, c, "red");
    if (c4Winner(copy) === "red") return c;
  }
  return validCols[Math.floor(Math.random() * validCols.length)];
}

// ---------- الذاكرة ----------
export function shuffledMemoryDeck(pairs) {
  const symbols = ["🍎","🍌","🍇","🍓","🍒","🍑","🥝","🍍","🥥","🍉","🍋","🍊"].slice(0, pairs);
  const deck = [...symbols, ...symbols];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

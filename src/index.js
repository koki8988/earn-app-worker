// =====================================================================
// index.js — Cloudflare Worker: بديل مجاني كامل لـ Firebase Cloud Functions
// نفس مبدأ الأمان: العميل لا يعدّل الرصيد أبداً، كل شيء يمر من هنا فقط.
// =====================================================================
import { requireAuth } from "./auth.js";
import {
  getDoc, setDoc, incrementField, commitDocWrite,
  createIfAbsent, setDocIfUnchanged, deleteDoc,
} from "./firestore.js";
import { xoWinner, xoAiMove, C4_ROWS, C4_COLS, c4Winner, c4Drop, c4AiMove, shuffledMemoryDeck } from "./games.js";
import { Chess } from "chess.js";

const CONFIG = {
  AD_REWARD: 10,
  AD_COOLDOWN_SECONDS: 30,
  MAX_ADS_PER_DAY: 50,
  REFERRAL_BONUS: 50,
  MIN_WITHDRAWAL_POINTS: 5000,
  POINTS_PER_USD: 1000,
  NUMBER_GAME_BET: 50,
  NUMBER_GAME_REWARD: 100,
  NUMBER_GAME_MAX_ATTEMPTS: 10,
  XO_BET: 50, XO_WIN_REWARD: 100, XO_DRAW_REFUND: 50,
  CONNECT4_BET: 50, CONNECT4_WIN_REWARD: 100, CONNECT4_DRAW_REFUND: 50,
  MEMORY_BET: 30, MEMORY_PAIRS: 8, MEMORY_MAX_MOVES: 24, MEMORY_WIN_REWARD: 80, MEMORY_WIN_REWARD_EFFICIENT: 120,
  CHESS_BET: 100, CHESS_WIN_REWARD: 250, CHESS_DRAW_REFUND: 100,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // بالإنتاج: استبدلها برابط موقعك فقط بدل *
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
function fail(message, status = 400) {
  return json({ error: message }, status);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureUserDoc(env, uid) {
  const existing = await getDoc(env, `users/${uid}`);
  if (existing) return existing;
  await setDoc(env, `users/${uid}`, {
    balance: 0, totalAds: 0, gamesPlayed: 0, gamesWon: 0, totalWithdrawn: 0, createdAt: new Date().toISOString(),
  });
  return getDoc(env, `users/${uid}`);
}

// =====================================================================
// مشاهدة إعلان (بفترة انتظار وسقف يومي محسوبين من السيرفر)
// =====================================================================
async function handleWatchAd(env, uid) {
  const user = await ensureUserDoc(env, uid);
  const now = Math.floor(Date.now() / 1000);
  const today = todayStr();

  if (user.lastAdAt) {
    const diff = now - Math.floor(new Date(user.lastAdAt).getTime() / 1000);
    if (diff < CONFIG.AD_COOLDOWN_SECONDS) {
      return fail(`انتظر ${CONFIG.AD_COOLDOWN_SECONDS - diff} ثانية قبل الإعلان التالي.`, 429);
    }
  }
  let todayAds = user.lastAdDate === today ? (user.todayAds || 0) : 0;
  if (todayAds >= CONFIG.MAX_ADS_PER_DAY) return fail("وصلت للحد الأقصى من الإعلانات اليوم.", 429);

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let streak = user.streak || 0;
  streak = user.lastVisit === today ? streak : (user.lastVisit === yesterday ? streak + 1 : 1);

  const r = await setDocIfUnchanged(env, `users/${uid}`,
    { lastAdDate: today, lastAdAt: new Date().toISOString(), lastVisit: today, streak, todayAds: todayAds + 1 },
    user.__updateTime);
  if (r.conflict) return fail("حاول مرة أخرى (تعارض تحديث).", 409);

  await incrementField(env, `users/${uid}`, "balance", CONFIG.AD_REWARD);
  await incrementField(env, `users/${uid}`, "totalAds", 1);

  return json({ reward: CONFIG.AD_REWARD, todayAds: todayAds + 1, streak });
}

// =====================================================================
// Postback من شبكة إعلانات (سر مشترك بسيط)
// =====================================================================
async function handleAdPostback(env, request) {
  const url = new URL(request.url);
  const params = request.method === "GET" ? url.searchParams : new URLSearchParams(await request.text());
  const uid = params.get("uid"), reward = params.get("reward"), secret = params.get("secret");
  const network = params.get("network"), txId = params.get("transaction_id");

  if (secret !== env.ADS_POSTBACK_SECRET) return fail("forbidden", 403);
  if (!uid || !reward) return fail("missing params", 400);

  const rewardAmount = Math.max(0, Math.min(parseInt(reward, 10) || 0, 1000));
  const dedupeKey = txId || `${uid}_${reward}_${Date.now()}`;
  const created = await createIfAbsent(env, `adEvents/${dedupeKey}`, {
    uid, rewardAmount, network: network || "unknown", verified: true, timestamp: new Date().toISOString(),
  });
  if (!created) return json({ status: "duplicate-ignored" });

  await ensureUserDoc(env, uid);
  await incrementField(env, `users/${uid}`, "balance", rewardAmount);
  await incrementField(env, `users/${uid}`, "totalAds", 1);
  return json({ status: "ok" });
}

// =====================================================================
// خمن الرقم
// =====================================================================
async function handleNumberGameStart(env, uid) {
  const user = await ensureUserDoc(env, uid);
  if ((user.balance || 0) < CONFIG.NUMBER_GAME_BET) return fail(`تحتاج ${CONFIG.NUMBER_GAME_BET} نقطة للعب.`, 402);

  const secret = Math.floor(Math.random() * 100) + 1;
  await incrementField(env, `users/${uid}`, "balance", -CONFIG.NUMBER_GAME_BET);
  await setDoc(env, `numberGameSessions/${uid}`, { secret, attempts: 0, min: 1, max: 100, active: true }, { merge: false });
  return json({ started: true, bet: CONFIG.NUMBER_GAME_BET });
}

async function handleNumberGameGuess(env, uid, body) {
  const guess = parseInt(body.guess, 10);
  if (isNaN(guess) || guess < 1 || guess > 100) return fail("رقم غير صالح.", 400);

  const session = await getDoc(env, `numberGameSessions/${uid}`);
  if (!session || !session.active) return fail("لا توجد لعبة نشطة.", 400);

  const attempts = (session.attempts || 0) + 1;

  if (guess === session.secret) {
    await incrementField(env, `users/${uid}`, "balance", CONFIG.NUMBER_GAME_REWARD);
    await commitDocWrite(env, `users/${uid}`, { increments: { gamesPlayed: 1, gamesWon: 1 } });
    await setDoc(env, `numberGameSessions/${uid}`, { active: false, attempts });
    return json({ result: "win", secret: session.secret, reward: CONFIG.NUMBER_GAME_REWARD });
  }
  if (attempts >= CONFIG.NUMBER_GAME_MAX_ATTEMPTS) {
    await commitDocWrite(env, `users/${uid}`, { increments: { gamesPlayed: 1 } });
    await setDoc(env, `numberGameSessions/${uid}`, { active: false, attempts });
    return json({ result: "lose", secret: session.secret });
  }
  const min = guess < session.secret ? Math.max(session.min, guess + 1) : session.min;
  const max = guess > session.secret ? Math.min(session.max, guess - 1) : session.max;
  await setDoc(env, `numberGameSessions/${uid}`, { attempts, min, max });
  return json({ result: guess < session.secret ? "higher" : "lower", attempts, min, max, remaining: CONFIG.NUMBER_GAME_MAX_ATTEMPTS - attempts });
}

// =====================================================================
// XO
// =====================================================================
async function handleXoStart(env, uid) {
  const user = await ensureUserDoc(env, uid);
  if ((user.balance || 0) < CONFIG.XO_BET) return fail(`تحتاج ${CONFIG.XO_BET} نقطة للعب.`, 402);
  await incrementField(env, `users/${uid}`, "balance", -CONFIG.XO_BET);
  await setDoc(env, `xoSessions/${uid}`, { board: Array(9).fill(""), active: true }, { merge: false });
  return json({ started: true, bet: CONFIG.XO_BET });
}

async function handleXoMove(env, uid, body) {
  const index = parseInt(body.index, 10);
  const session = await getDoc(env, `xoSessions/${uid}`);
  if (!session || !session.active) return fail("لا توجد لعبة نشطة.", 400);
  if (isNaN(index) || index < 0 || index > 8 || session.board[index]) return fail("حركة غير صالحة.", 400);

  const board = [...session.board];
  board[index] = "X";
  let winner = xoWinner(board);
  let aiIndex = null;
  if (!winner && board.includes("")) {
    aiIndex = xoAiMove(board);
    if (aiIndex !== null && aiIndex !== undefined) board[aiIndex] = "O";
    winner = xoWinner(board);
  }
  const isDraw = !winner && !board.includes("");

  if (winner || isDraw) {
    await setDoc(env, `xoSessions/${uid}`, { board, active: false });
    if (winner === "X") await commitDocWrite(env, `users/${uid}`, { increments: { balance: CONFIG.XO_WIN_REWARD, gamesPlayed: 1, gamesWon: 1 } });
    else if (isDraw) await commitDocWrite(env, `users/${uid}`, { increments: { balance: CONFIG.XO_DRAW_REFUND, gamesPlayed: 1 } });
    else await commitDocWrite(env, `users/${uid}`, { increments: { gamesPlayed: 1 } });
    return json({ board, result: winner === "X" ? "win" : winner === "O" ? "lose" : "draw", aiIndex });
  }
  await setDoc(env, `xoSessions/${uid}`, { board });
  return json({ board, result: "continue", aiIndex });
}

// =====================================================================
// أربع في صف
// =====================================================================
async function handleConnect4Start(env, uid) {
  const user = await ensureUserDoc(env, uid);
  if ((user.balance || 0) < CONFIG.CONNECT4_BET) return fail(`تحتاج ${CONFIG.CONNECT4_BET} نقطة للعب.`, 402);
  await incrementField(env, `users/${uid}`, "balance", -CONFIG.CONNECT4_BET);
  const board = Array.from({ length: C4_ROWS }, () => Array(C4_COLS).fill(null));
  await setDoc(env, `connect4Sessions/${uid}`, { board, active: true }, { merge: false });
  return json({ started: true, bet: CONFIG.CONNECT4_BET });
}

async function handleConnect4Move(env, uid, body) {
  const col = parseInt(body.col, 10);
  const session = await getDoc(env, `connect4Sessions/${uid}`);
  if (!session || !session.active) return fail("لا توجد لعبة نشطة.", 400);
  if (isNaN(col) || col < 0 || col >= C4_COLS || session.board[0][col]) return fail("عمود غير صالح.", 400);

  const board = session.board.map((row) => [...row]);
  c4Drop(board, col, "red");
  let winner = c4Winner(board);
  let aiCol = null;
  if (!winner && !board[0].every((c) => c !== null)) {
    aiCol = c4AiMove(board);
    c4Drop(board, aiCol, "yellow");
    winner = c4Winner(board);
  }
  const isDraw = !winner && board[0].every((c) => c !== null);

  if (winner || isDraw) {
    await setDoc(env, `connect4Sessions/${uid}`, { board, active: false });
    if (winner === "red") await commitDocWrite(env, `users/${uid}`, { increments: { balance: CONFIG.CONNECT4_WIN_REWARD, gamesPlayed: 1, gamesWon: 1 } });
    else if (isDraw) await commitDocWrite(env, `users/${uid}`, { increments: { balance: CONFIG.CONNECT4_DRAW_REFUND, gamesPlayed: 1 } });
    else await commitDocWrite(env, `users/${uid}`, { increments: { gamesPlayed: 1 } });
    return json({ board, result: winner === "red" ? "win" : winner === "yellow" ? "lose" : "draw", aiCol });
  }
  await setDoc(env, `connect4Sessions/${uid}`, { board });
  return json({ board, result: "continue", aiCol });
}

// =====================================================================
// الذاكرة
// =====================================================================
async function handleMemoryStart(env, uid) {
  const user = await ensureUserDoc(env, uid);
  if ((user.balance || 0) < CONFIG.MEMORY_BET) return fail(`تحتاج ${CONFIG.MEMORY_BET} نقطة للعب.`, 402);
  await incrementField(env, `users/${uid}`, "balance", -CONFIG.MEMORY_BET);
  const deck = shuffledMemoryDeck(CONFIG.MEMORY_PAIRS);
  await setDoc(env, `memorySessions/${uid}`, { deck, matched: [], pendingIndex: -1, moves: 0, active: true }, { merge: false });
  return json({ started: true, bet: CONFIG.MEMORY_BET, cardCount: deck.length });
}

async function handleMemoryFlip(env, uid, body) {
  const index = parseInt(body.index, 10);
  const s = await getDoc(env, `memorySessions/${uid}`);
  if (!s || !s.active) return fail("لا توجد لعبة نشطة.", 400);
  if (isNaN(index) || index < 0 || index >= s.deck.length || s.matched.includes(index) || index === s.pendingIndex) {
    return fail("بطاقة غير صالحة.", 400);
  }

  if (s.pendingIndex === -1 || s.pendingIndex === null) {
    await setDoc(env, `memorySessions/${uid}`, { pendingIndex: index });
    return json({ symbol: s.deck[index], matched: null, gameOver: false });
  }

  const moves = (s.moves || 0) + 1;
  const isMatch = s.deck[s.pendingIndex] === s.deck[index];
  const matched = isMatch ? [...s.matched, s.pendingIndex, index] : s.matched;
  const allMatched = matched.length === s.deck.length;
  const outOfMoves = !allMatched && moves >= CONFIG.MEMORY_MAX_MOVES;

  const result = { symbol: s.deck[index], matched: isMatch, pendingSymbol: s.deck[s.pendingIndex], gameOver: false };

  if (allMatched) {
    const reward = moves <= CONFIG.MEMORY_PAIRS + 6 ? CONFIG.MEMORY_WIN_REWARD_EFFICIENT : CONFIG.MEMORY_WIN_REWARD;
    await commitDocWrite(env, `users/${uid}`, { increments: { balance: reward, gamesPlayed: 1, gamesWon: 1 } });
    await setDoc(env, `memorySessions/${uid}`, { matched, moves, pendingIndex: -1, active: false });
    result.gameOver = true; result.outcome = "win"; result.reward = reward;
  } else if (outOfMoves) {
    await commitDocWrite(env, `users/${uid}`, { increments: { gamesPlayed: 1 } });
    await setDoc(env, `memorySessions/${uid}`, { matched, moves, pendingIndex: -1, active: false });
    result.gameOver = true; result.outcome = "lose";
  } else {
    await setDoc(env, `memorySessions/${uid}`, { matched, moves, pendingIndex: -1 });
  }
  return json(result);
}

// =====================================================================
// الشطرنج (باستخدام مكتبة chess.js نفسها، مجمّعة داخل الـ Worker)
// =====================================================================
async function handleChessStart(env, uid) {
  const user = await ensureUserDoc(env, uid);
  if ((user.balance || 0) < CONFIG.CHESS_BET) return fail(`تحتاج ${CONFIG.CHESS_BET} نقطة للعب.`, 402);
  await incrementField(env, `users/${uid}`, "balance", -CONFIG.CHESS_BET);
  const chess = new Chess();
  await setDoc(env, `chessSessions/${uid}`, { fen: chess.fen(), active: true }, { merge: false });
  return json({ started: true, bet: CONFIG.CHESS_BET, fen: chess.fen() });
}

async function handleChessMove(env, uid, body) {
  const { from, to, promotion } = body;
  const s = await getDoc(env, `chessSessions/${uid}`);
  if (!s || !s.active) return fail("لا توجد لعبة نشطة.", 400);

  const chess = new Chess(s.fen);
  const move = chess.move({ from, to, promotion: promotion || "q" });
  if (!move) return fail("نقلة غير قانونية.", 400);

  let result = "continue", aiMove = null;
  if (chess.isGameOver()) {
    result = chess.isCheckmate() ? "win" : "draw";
  } else {
    const legalMoves = chess.moves({ verbose: true });
    aiMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];
    chess.move({ from: aiMove.from, to: aiMove.to, promotion: "q" });
    if (chess.isGameOver()) result = chess.isCheckmate() ? "lose" : "draw";
  }

  if (result !== "continue") {
    await setDoc(env, `chessSessions/${uid}`, { fen: chess.fen(), active: false });
    if (result === "win") await commitDocWrite(env, `users/${uid}`, { increments: { balance: CONFIG.CHESS_WIN_REWARD, gamesPlayed: 1, gamesWon: 1 } });
    else if (result === "draw") await commitDocWrite(env, `users/${uid}`, { increments: { balance: CONFIG.CHESS_DRAW_REFUND, gamesPlayed: 1 } });
    else await commitDocWrite(env, `users/${uid}`, { increments: { gamesPlayed: 1 } });
  } else {
    await setDoc(env, `chessSessions/${uid}`, { fen: chess.fen() });
  }
  return json({ fen: chess.fen(), result, aiMove });
}

// =====================================================================
// المهام اليومية
// =====================================================================
const TASKS = {
  watch5: { reward: 20, check: (u) => (u.todayAds || 0) >= 5 },
  game1: { reward: 30, check: (u) => (u.gamesPlayed || 0) >= 1 },
  dailyLogin: { reward: 10, check: (u) => u.lastVisit === todayStr() },
};

async function handleClaimTask(env, uid, body) {
  const task = TASKS[body.taskId];
  if (!task) return fail("مهمة غير صالحة.", 400);
  const user = await ensureUserDoc(env, uid);
  if (!task.check(user)) return fail("المهمة غير مكتملة بعد.", 400);

  const claimPath = `users/${uid}/claimedTasks/${todayStr()}_${body.taskId}`;
  const created = await createIfAbsent(env, claimPath, { claimedAt: new Date().toISOString() });
  if (!created) return fail("تم استلام هذه المهمة اليوم.", 409);

  await incrementField(env, `users/${uid}`, "balance", task.reward);
  return json({ reward: task.reward });
}

// =====================================================================
// الاستطلاعات
// =====================================================================
const SURVEYS = {
  s1: { reward: 30, options: ["الصباح", "المساء", "الليل"] },
  s2: { reward: 25, options: ["1-3", "4-7", "8+"] },
  s3: { reward: 35, options: ["ألعاب", "استبيانات أكثر", "سحب سريع"] },
};

async function handleAnswerSurvey(env, uid, body) {
  const survey = SURVEYS[body.surveyId];
  if (!survey || !survey.options.includes(body.answer)) return fail("استطلاع غير صالح.", 400);

  const answerPath = `users/${uid}/surveyAnswers/${body.surveyId}`;
  const created = await createIfAbsent(env, answerPath, { answer: body.answer, answeredAt: new Date().toISOString() });
  if (!created) return fail("لقد أجبت على هذا الاستطلاع مسبقاً.", 409);

  await incrementField(env, `users/${uid}`, "balance", survey.reward);
  return json({ reward: survey.reward });
}

// =====================================================================
// الإحالة وصندوق الحظ
// =====================================================================
async function handleClaimReferralBonus(env, uid) {
  const user = await ensureUserDoc(env, uid);
  const today = todayStr();
  if (user.lastReferralClaim === today) return fail("تم استلام مكافأة الإحالة اليوم.", 409);
  await commitDocWrite(env, `users/${uid}`, { fields: { lastReferralClaim: today }, increments: { balance: CONFIG.REFERRAL_BONUS } });
  return json({ reward: CONFIG.REFERRAL_BONUS });
}

async function handleOpenLuckyBox(env, uid) {
  const user = await ensureUserDoc(env, uid);
  const today = todayStr();
  if (user.luckyBoxDate === today) return fail("فتحت صندوق الحظ اليوم بالفعل.", 409);
  const reward = Math.floor(Math.random() * 450) + 50;
  await commitDocWrite(env, `users/${uid}`, { fields: { luckyBoxDate: today }, increments: { balance: reward } });
  return json({ reward });
}

// =====================================================================
// السحب
// =====================================================================
async function handleRequestWithdrawal(env, uid, body) {
  const { amount, method, destination } = body;
  if (!amount || amount < CONFIG.MIN_WITHDRAWAL_POINTS) return fail(`الحد الأدنى للسحب ${CONFIG.MIN_WITHDRAWAL_POINTS} نقطة.`, 400);
  if (!method || !destination) return fail("بيانات السحب ناقصة.", 400);

  const user = await ensureUserDoc(env, uid);
  if ((user.balance || 0) < amount) return fail("رصيدك غير كافٍ.", 402);

  await incrementField(env, `users/${uid}`, "balance", -amount);
  const wId = crypto.randomUUID();
  await setDoc(env, `withdrawals/${wId}`, {
    uid, amount, usdValue: +(amount / CONFIG.POINTS_PER_USD).toFixed(2),
    method, destination, status: "pending", requestedAt: new Date().toISOString(),
  }, { merge: false });
  return json({ withdrawalId: wId, status: "pending" });
}

async function paypalAccessToken(env) {
  const base = env.PAYPAL_MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const resp = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("PayPal auth failed: " + JSON.stringify(data));
  return { token: data.access_token, base };
}

async function sendPaypalPayout(env, destinationEmail, amountUsd, note) {
  const { token, base } = await paypalAccessToken(env);
  const resp = await fetch(`${base}/v1/payments/payouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: crypto.randomUUID(), email_subject: "دفعة أرباحك", email_message: note },
      items: [{
        recipient_type: "EMAIL",
        amount: { value: amountUsd.toFixed(2), currency: "USD" },
        receiver: destinationEmail,
        note,
      }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error("PayPal payout failed: " + JSON.stringify(data));
  return data;
}

async function handleReviewWithdrawal(env, uid, body) {
  const admin = await getDoc(env, `admins/${uid}`);
  if (!admin) return fail("غير مصرح.", 403);

  const { withdrawalId, approve } = body;
  const w = await getDoc(env, `withdrawals/${withdrawalId}`);
  if (!w || w.status !== "pending") return fail("طلب غير صالح.", 400);

  // قفل الطلب فوراً لمنع أي معالجة مزدوجة قبل بدء التحويل الفعلي
  const lock = await setDocIfUnchanged(env, `withdrawals/${withdrawalId}`, { status: "processing" }, w.__updateTime);
  if (lock.conflict) return fail("جاري معالجة هذا الطلب بالفعل.", 409);

  if (!approve) {
    await incrementField(env, `users/${w.uid}`, "balance", w.amount);
    await setDoc(env, `withdrawals/${withdrawalId}`, { status: "rejected", reviewedAt: new Date().toISOString() });
    return json({ status: "rejected" });
  }

  try {
    if (w.method === "paypal") {
      const payout = await sendPaypalPayout(env, w.destination, w.usdValue, `دفعة ${w.usdValue}$`);
      await setDoc(env, `withdrawals/${withdrawalId}`, {
        status: "approved", reviewedAt: new Date().toISOString(), paypalBatchId: payout.batch_header?.payout_batch_id || null,
      });
      await incrementField(env, `users/${w.uid}`, "totalWithdrawn", w.amount);
      return json({ status: "approved" });
    }
    // تحويل بنكي: لا يوجد API موحّد، يُعتمد يدوياً بعد التحويل الفعلي
    await setDoc(env, `withdrawals/${withdrawalId}`, { status: "approved", reviewedAt: new Date().toISOString(), note: "يتطلب تحويل بنكي يدوي" });
    await incrementField(env, `users/${w.uid}`, "totalWithdrawn", w.amount);
    return json({ status: "approved", manual: true });
  } catch (err) {
    // فشل الدفع الفعلي: رجّع الطلب لحالة pending ليُعاد المحاولة، ولا تُرجع النقاط (الطلب لسه صالح)
    await setDoc(env, `withdrawals/${withdrawalId}`, { status: "pending", lastError: String(err.message || err) });
    return fail("فشل تنفيذ الدفع، تمت إعادة الطلب لقائمة الانتظار: " + err.message, 502);
  }
}

// =====================================================================
// المهام الاجتماعية (يوتيوب/تيك توك) — يضيفها المالك، يكملها المستخدمون
// =====================================================================
async function handleCompleteSocialTask(env, uid, body) {
  const { taskId } = body;
  if (!taskId) return fail("مهمة غير صالحة.", 400);

  const task = await getDoc(env, `socialTasks/${taskId}`);
  if (!task || !task.active) return fail("المهمة غير متاحة.", 400);

  const markerPath = `users/${uid}/completedSocialTasks/${taskId}`;
  const created = await createIfAbsent(env, markerPath, { completedAt: new Date().toISOString() });
  if (!created) return fail("لقد أنجزت هذه المهمة مسبقاً.", 409);

  const reward = task.reward || 50;
  await incrementField(env, `users/${uid}`, "balance", reward);
  return json({ reward });
}

// =====================================================================
// طلب ترويج مدفوع — يُنشئ طلباً بحالة "pending" فقط (الدفع الفعلي والموافقة
// تتم يدوياً من لوحة المالك بعد تأكيد استلام المبلغ عبر PayPal)
// =====================================================================
const PROMO_PRICES = { 7: 5, 14: 8, 30: 12 }; // أيام: دولار

async function handleSubmitPromoRequest(env, uid, body) {
  const { channelName, link, platform, duration } = body;
  const days = parseInt(duration, 10);
  if (!channelName || !link || !platform || !PROMO_PRICES[days]) return fail("بيانات الطلب ناقصة أو غير صالحة.", 400);

  const id = crypto.randomUUID();
  await setDoc(env, `promoRequests/${id}`, {
    uid, channelName, link, platform, duration: days,
    priceUsd: PROMO_PRICES[days], status: "pending", createdAt: new Date().toISOString(),
  }, { merge: false });
  return json({ requestId: id, priceUsd: PROMO_PRICES[days] });
}

// =====================================================================
// رسائل الدعم الفني
// =====================================================================
async function handleSendSupportMessage(env, uid, body) {
  const { name, email, message } = body;
  if (!name || !email || !message) return fail("يرجى ملء جميع الحقول.", 400);

  const id = crypto.randomUUID();
  await setDoc(env, `supportMessages/${id}`, {
    uid, name, email, message, status: "open", createdAt: new Date().toISOString(),
  }, { merge: false });
  return json({ messageId: id });
}

// =====================================================================
// لوحة تحكم المالك (كل الدوال هنا تتحقق من admins/{uid} أولاً)
// =====================================================================
async function requireAdmin(env, uid) {
  const admin = await getDoc(env, `admins/${uid}`);
  if (!admin) {
    const err = new Error("غير مصرح لك بهذا الإجراء.");
    err.status = 403;
    throw err;
  }
}

async function handleAdminAddSocialTask(env, uid, body) {
  await requireAdmin(env, uid);
  const { title, link, platform, reward } = body;
  if (!title || !link || !platform) return fail("بيانات المهمة ناقصة.", 400);

  const id = crypto.randomUUID();
  await setDoc(env, `socialTasks/${id}`, {
    title, link, platform, reward: parseInt(reward, 10) || 50, active: true, createdAt: new Date().toISOString(),
  }, { merge: false });
  return json({ taskId: id });
}

async function handleAdminDeleteSocialTask(env, uid, body) {
  await requireAdmin(env, uid);
  if (!body.taskId) return fail("مهمة غير صالحة.", 400);
  await deleteDoc(env, `socialTasks/${body.taskId}`);
  return json({ deleted: true });
}

async function handleAdminReviewPromo(env, uid, body) {
  await requireAdmin(env, uid);
  const { requestId, approve } = body;
  const req = await getDoc(env, `promoRequests/${requestId}`);
  if (!req || req.status !== "pending") return fail("طلب غير صالح.", 400);

  if (approve) {
    // عند الموافقة (بعد تأكيد استلام الدفع يدوياً)، تتحول لمهمة اجتماعية فعلية
    const taskId = crypto.randomUUID();
    await setDoc(env, `socialTasks/${taskId}`, {
      title: req.channelName, link: req.link, platform: req.platform,
      reward: 50, active: true, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + req.duration * 86400000).toISOString(),
    }, { merge: false });
    await setDoc(env, `promoRequests/${requestId}`, { status: "approved", taskId, reviewedAt: new Date().toISOString() });
  } else {
    await setDoc(env, `promoRequests/${requestId}`, { status: "rejected", reviewedAt: new Date().toISOString() });
  }
  return json({ status: approve ? "approved" : "rejected" });
}

async function handleAdminDeleteSupportMessage(env, uid, body) {
  await requireAdmin(env, uid);
  if (!body.messageId) return fail("رسالة غير صالحة.", 400);
  await deleteDoc(env, `supportMessages/${body.messageId}`);
  return json({ deleted: true });
}

// =====================================================================
// التوجيه (Router)
// =====================================================================
const PUBLIC_ROUTES = new Set(["/adPostback"]); // مسارات بلا توكن مستخدم (تتحقق بطريقتها الخاصة)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      if (path === "/adPostback") return handleAdPostback(env, request);

      if (request.method !== "POST") return fail("Method not allowed", 405);
      const body = await request.json().catch(() => ({}));
      const { uid } = await requireAuth(request, env);

      switch (path) {
        case "/watchAd": return handleWatchAd(env, uid);
        case "/numberGameStart": return handleNumberGameStart(env, uid);
        case "/numberGameGuess": return handleNumberGameGuess(env, uid, body);
        case "/xoStart": return handleXoStart(env, uid);
        case "/xoMove": return handleXoMove(env, uid, body);
        case "/connect4Start": return handleConnect4Start(env, uid);
        case "/connect4Move": return handleConnect4Move(env, uid, body);
        case "/memoryStart": return handleMemoryStart(env, uid);
        case "/memoryFlip": return handleMemoryFlip(env, uid, body);
        case "/chessStart": return handleChessStart(env, uid);
        case "/chessMove": return handleChessMove(env, uid, body);
        case "/claimTask": return handleClaimTask(env, uid, body);
        case "/answerSurvey": return handleAnswerSurvey(env, uid, body);
        case "/claimReferralBonus": return handleClaimReferralBonus(env, uid);
        case "/openLuckyBox": return handleOpenLuckyBox(env, uid);
        case "/requestWithdrawal": return handleRequestWithdrawal(env, uid, body);
        case "/reviewWithdrawal": return handleReviewWithdrawal(env, uid, body);
        case "/completeSocialTask": return handleCompleteSocialTask(env, uid, body);
        case "/submitPromoRequest": return handleSubmitPromoRequest(env, uid, body);
        case "/sendSupportMessage": return handleSendSupportMessage(env, uid, body);
        case "/adminAddSocialTask": return handleAdminAddSocialTask(env, uid, body);
        case "/adminDeleteSocialTask": return handleAdminDeleteSocialTask(env, uid, body);
        case "/adminReviewPromo": return handleAdminReviewPromo(env, uid, body);
        case "/adminDeleteSupportMessage": return handleAdminDeleteSupportMessage(env, uid, body);
        default: return fail("Not found", 404);
      }
    } catch (err) {
      const status = err.status || 500;
      return fail(err.message || "خطأ داخلي", status);
    }
  },
};

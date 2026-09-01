// =====================================================================
// auth.js — تحقق من Firebase ID Token بدون firebase-admin (غير متاح بـ Workers)
// يتحقق من التوقيع الحقيقي بمفاتيح جوجل العامة (JWK) + كل الحقول المطلوبة
// =====================================================================

let cachedKeys = { jwks: null, fetchedAt: 0 };

async function getGoogleJwks() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (cachedKeys.jwks && Date.now() - cachedKeys.fetchedAt < ONE_HOUR) return cachedKeys.jwks;
  const resp = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.google.com");
  const jwks = await resp.json();
  cachedKeys = { jwks, fetchedAt: Date.now() };
  return jwks;
}

function base64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodeJwtPart(part) {
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(part)));
}

// يتحقق من توكن Firebase ويرجع { uid, email, name } إن كان صالحاً، أو يرمي خطأ
export async function verifyFirebaseToken(idToken, projectId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("توكن غير صالح الصيغة");

  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  const signature = base64urlToBytes(parts[2]);
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("انتهت صلاحية التوكن");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("مُصدر التوكن غير صحيح");
  if (payload.aud !== projectId) throw new Error("الجمهور المستهدف غير صحيح");
  if (!payload.sub) throw new Error("لا يوجد uid بالتوكن");

  const jwks = await getGoogleJwks();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("مفتاح التوقيع غير معروف (kid غير مطابق)");

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signedData);
  if (!valid) throw new Error("توقيع التوكن غير صالح");

  return { uid: payload.sub, email: payload.email || null, name: payload.name || null };
}

// يستخرج ويتحقق من التوكن من هيدر Authorization: Bearer <token>
export async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    const err = new Error("مطلوب تسجيل الدخول");
    err.status = 401;
    throw err;
  }
  try {
    return await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
  } catch (e) {
    const err = new Error("توكن دخول غير صالح: " + e.message);
    err.status = 401;
    throw err;
  }
}

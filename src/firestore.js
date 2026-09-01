// =====================================================================
// firestore.js — عميل Firestore REST خفيف يعمل داخل Cloudflare Workers
// (Workers لا تدعم firebase-admin لأنه مبني على Node، فنستخدم REST API
// مباشرة + Web Crypto لتوقيع JWT الخاص بحساب الخدمة)
// =====================================================================

let cachedToken = { value: null, expiresAt: 0 };

function base64url(bytes) {
  let str = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
  // يتسامح مع أي شكل يُلصَق فيه المفتاح: أسطر حقيقية، أو رمز \n حرفي (شائع
  // عند نسخ القيمة من داخل ملف JSON مباشرة بدون تفسير الأسطر).
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized.replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// يحصل على OAuth2 access token صالح لاستخدام Firestore REST API، بالتوقيع
// بمفتاح حساب الخدمة (JWT Bearer flow) — يُخزَّن مؤقتاً بالذاكرة لتقليل الطلبات
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.value && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const encHeader = base64url(JSON.stringify(header));
  const encClaim = base64url(JSON.stringify(claim));
  const signInput = `${encHeader}.${encClaim}`;

  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signInput)
  );
  const jwt = `${signInput}.${base64url(signature)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("تعذر الحصول على توكن Firestore: " + JSON.stringify(data));

  cachedToken = { value: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return cachedToken.value;
}

function baseUrl(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// يحوّل قيم JS العادية لصيغة Firestore REST (fields بصيغة {stringValue: ..} إلخ)
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object") {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = toFirestoreValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in v) {
    const out = {};
    for (const k of Object.keys(v.mapValue.fields || {})) out[k] = fromFirestoreValue(v.mapValue.fields[k]);
    return out;
  }
  return null;
}

function docToObject(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const k of Object.keys(doc.fields)) out[k] = fromFirestoreValue(doc.fields[k]);
  out.__updateTime = doc.updateTime;
  out.__name = doc.name;
  return out;
}

// قراءة مستند واحد — يرجع null إذا غير موجود
export async function getDoc(env, path) {
  const token = await getAccessToken(env);
  const resp = await fetch(`${baseUrl(env)}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Firestore get failed: ${resp.status} ${await resp.text()}`);
  return docToObject(await resp.json());
}

// كتابة/دمج حقول بمستند (merge بدون حذف الحقول الأخرى)
export async function setDoc(env, path, fields, { merge = true } = {}) {
  const token = await getAccessToken(env);
  const mask = merge ? `?${Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&")}` : "";
  const resp = await fetch(`${baseUrl(env)}/${path}${mask}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFirestoreValue(v)])) }),
  });
  if (!resp.ok) throw new Error(`Firestore set failed: ${resp.status} ${await resp.text()}`);
  return docToObject(await resp.json());
}

// زيادة/نقصان حقل رقمي بشكل ذرّي حقيقي (يُنفَّذ على السيرفر، آمن من التسابق)
export async function incrementField(env, path, field, amount) {
  const token = await getAccessToken(env);
  const resp = await fetch(`${baseUrl(env)}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        transform: {
          document: `${baseUrl(env)}/${path}`,
          fieldTransforms: [{ fieldPath: field, increment: Number.isInteger(amount) ? { integerValue: String(amount) } : { doubleValue: amount } }],
        },
      }],
    }),
  });
  if (!resp.ok) throw new Error(`Firestore increment failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// كتابة عدة تحويلات (زيادات + قيم عادية) بعملية commit واحدة ذرّية على مستند واحد
export async function commitDocWrite(env, path, { fields = null, increments = {} } = {}) {
  const token = await getAccessToken(env);
  const writes = [];
  if (fields) {
    writes.push({
      update: { name: `${baseUrl(env)}/${path}`, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFirestoreValue(v)])) },
      updateMask: { fieldPaths: Object.keys(fields) },
    });
  }
  const incKeys = Object.keys(increments);
  if (incKeys.length) {
    writes.push({
      transform: {
        document: `${baseUrl(env)}/${path}`,
        fieldTransforms: incKeys.map((k) => ({
          fieldPath: k,
          increment: Number.isInteger(increments[k]) ? { integerValue: String(increments[k]) } : { doubleValue: increments[k] },
        })),
      },
    });
  }
  const resp = await fetch(`${baseUrl(env)}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (!resp.ok) throw new Error(`Firestore commit failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// إنشاء مستند فقط إذا لم يكن موجوداً (يُستخدم لمنع التكرار: مطالبة مهمة مرتين، إلخ)
// يرجع true لو اتكتب فعلاً، false لو كان موجود مسبقاً (منع تكرار ذرّي حقيقي)
export async function createIfAbsent(env, path, fields) {
  const token = await getAccessToken(env);
  const resp = await fetch(`${baseUrl(env)}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        update: { name: `${baseUrl(env)}/${path}`, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFirestoreValue(v)])) },
        currentDocument: { exists: false },
      }],
    }),
  });
  if (resp.status === 409 || resp.status === 400) {
    const text = await resp.text();
    if (text.includes("ALREADY_EXISTS") || text.includes("FAILED_PRECONDITION")) return false;
    throw new Error(`Firestore createIfAbsent failed: ${resp.status} ${text}`);
  }
  if (!resp.ok) throw new Error(`Firestore createIfAbsent failed: ${resp.status} ${await resp.text()}`);
  return true;
}

// كتابة مشروطة بزمن آخر تحديث معروف (تفاؤلي concurrency control) — تُستخدم
// لتحديث جلسات الألعاب بأمان من التسابق (نفس مبدأ Transaction لكن عبر REST)
export async function setDocIfUnchanged(env, path, fields, expectedUpdateTime) {
  const token = await getAccessToken(env);
  const resp = await fetch(`${baseUrl(env)}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        update: { name: `${baseUrl(env)}/${path}`, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFirestoreValue(v)])) },
        updateMask: { fieldPaths: Object.keys(fields) },
        currentDocument: expectedUpdateTime ? { updateTime: expectedUpdateTime } : { exists: true },
      }],
    }),
  });
  if (resp.status === 400 || resp.status === 409) return { conflict: true };
  if (!resp.ok) throw new Error(`Firestore setDocIfUnchanged failed: ${resp.status} ${await resp.text()}`);
  return { conflict: false, result: await resp.json() };
}

export async function deleteDoc(env, path) {
  const token = await getAccessToken(env);
  await fetch(`${baseUrl(env)}/${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}

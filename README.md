# تطبيق كسب المال — Backend مجاني بالكامل (Cloudflare Workers)

## لماذا هذا التغيير؟
Firebase Cloud Functions يتطلب خطة Blaze (بطاقة بنكية) إجبارياً، وبالسعودية
هذا يمر عبر وسيط (CNTXT). **Cloudflare Workers بديل مجاني حقيقي 100%** بدون
أي بطاقة أو وسيط: 100,000 طلب يومياً مجاناً، تسجيل حساب بالبريد فقط.

**ما تغيّر:**
- تسجيل الدخول (Firebase Authentication) — **بدون تغيير**، يبقى نفسه
- تخزين البيانات (Firestore) — **بدون تغيير**، يبقى نفسه (مجاني على خطة Spark)
- منطق الرصيد الآمن — انتقل من *Cloud Functions* إلى *Cloudflare Worker*
  (مجلد `worker/` الجديد)، يتواصل مع Firestore عبر REST API مباشرة

## الملفات الجديدة
- `worker/src/index.js` — كل نقاط الـ API (بديل exports.watchAd إلخ)
- `worker/src/firestore.js` — عميل Firestore REST (بدون firebase-admin)
- `worker/src/auth.js` — التحقق من Firebase ID Token بمفاتيح جوجل العامة
- `worker/src/games.js` — منطق الألعاب الخالص (XO، أربع في صف، الذاكرة)
- `worker/wrangler.toml` + `worker/package.json` — إعدادات النشر

---

## خطوات النشر (كلها ممكنة من Termux على الجوال)

### 1. أنشئ حساب Cloudflare (بالبريد فقط، بدون بطاقة)
اذهب لـ `https://dash.cloudflare.com/sign-up` وسجّل بريدك.

### 2. احصل على مفتاح Service Account لـ Firestore
هذا يحل محل صلاحيات Admin SDK، ولا يتطلب خطة Blaze — متاح على Spark:
1. Firebase Console → ⚙️ **Project Settings** → تبويب **Service Accounts**
2. اضغط **Generate new private key** → ينزّل ملف JSON
3. افتح الملف (من متصفح الجوال أو Termux: `cat ~/storage/downloads/اسم-الملف.json`)
   بداخله تحتاج قيمتين: `client_email` و `private_key`

### 3. ثبّت Wrangler (أداة نشر Cloudflare) داخل Termux
```bash
cd ~/earn-app/worker
npm install
```

### 4. سجّل دخول بحساب Cloudflare
```bash
npx wrangler login
```
بيفتح رابط بالمتصفح، سجّل دخول ووافق.

### 5. اضبط الأسرار (لا تُكتب بأي ملف، تُخزَّن مشفّرة عند Cloudflare)
```bash
npx wrangler secret put FIREBASE_CLIENT_EMAIL
```
(الصق قيمة `client_email` من ملف الـ JSON)

```bash
npx wrangler secret put FIREBASE_PRIVATE_KEY
```
(الصق قيمة `private_key` كاملة — تشمل أسطر `-----BEGIN PRIVATE KEY-----` و `-----END PRIVATE KEY-----`)

```bash
npx wrangler secret put ADS_POSTBACK_SECRET
```
(اختر أي كلمة سر قوية من عندك، لإعلانات الشبكات اللي تدعم postback)

```bash
npx wrangler secret put PAYPAL_CLIENT_ID
npx wrangler secret put PAYPAL_CLIENT_SECRET
```
(نفس القيم اللي أخذتها من PayPal Developer Dashboard سابقاً)

### 6. انشر الـ Worker
```bash
npx wrangler deploy
```
بعد النجاح، بيطبع لك رابط شكله:
```
https://earn-app-backend.YOUR_SUBDOMAIN.workers.dev
```
**انسخ هذا الرابط بالضبط.**

### 7. حدّث الواجهة بالرابط الحقيقي
افتح `public/index.html` بمحرر Termux (`nano public/index.html` أو أي محرر)،
دوّر على السطر:
```js
const WORKER_URL = "https://earn-app-backend.YOUR_SUBDOMAIN.workers.dev";
```
واستبدله بالرابط الحقيقي من الخطوة 6.

### 8. انشر الموقع (Firebase Hosting يبقى مجانياً، بدون Blaze)
```bash
cd ~/earn-app
npx firebase-tools deploy --only firestore:rules,hosting
```
(لاحظ: بدون `functions` هذي المرة — انتقلت لـ Worker)

---

## نقطة أمان مهمة (CORS)
بملف `worker/src/index.js` القيمة:
```js
"Access-Control-Allow-Origin": "*"
```
هذا يسمح لأي موقع ينادي الـ Worker. بعد التأكد كل شيء يعمل، استبدلها برابط
موقعك فقط (مثلاً `"https://earn-money-app-a14a8.web.app"`) لمنع أي موقع آخر
من استخدام الـ Backend تبعك، ثم أعد النشر (`npx wrangler deploy`).

## AdMob SSV ومرحلة الموبايل
نفس مبدأ AdMob (تحقق بتوقيع ECDSA) قابل للتنفيذ داخل Worker أيضاً (Web Crypto
مدعوم بالكامل)، لكن لم أُدرجها بهذا التسليم لتوفير الوقت — أخبرني إذا وصلت
لمرحلة تفعيل AdMob فعلياً (بعد تحويل التطبيق لموبايل عبر Capacitor) وأجهزها.

## ما الذي لم يتغيّر
- خطوات Capacitor لتطبيق الموبايل (من الجولة السابقة) تبقى كما هي تماماً —
  الواجهة تنادي نفس دوال `call('اسم')` بغض النظر عن كون الـ Backend
  Cloud Functions أو Worker.
- `firestore.rules` يبقى كما هو، ينشر بنفس الطريقة.

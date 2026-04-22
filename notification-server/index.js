/* ============================================================
   CallingApp — Notification + Media Server  v3.1  (Production)
   ============================================================
   Stack    : Node.js 18+ | Express 4 | Firebase Admin 12 | Cloudinary 2
   Security : Helmet | CORS | Rate-limit | API-Key | Idempotency | HSTS
   Logging  : Structured JSON (stdout) — ready for Datadog / Logtail / Loki
   Metrics  : GET /api/metrics  (Prometheus text format)
   Retry    : Exponential back-off for transient Firebase errors
   Multi    : Per-user multi-device token fan-out
   Schedule : In-process future delivery queue
   Media    : Cloudinary signed upload + admin destroy
   Graceful : SIGTERM / SIGINT drain + forced exit fallback

   Endpoints
   ─────────────────────────────────────────────────────────────
   GET  /                            health + version + uptime
   GET  /healthz                     liveness probe (Firebase ping)
   GET  /api/stats                   delivery counters       [key]
   GET  /api/metrics                 Prometheus text         [key]
   POST /api/register-token          register device token
   POST /api/delete-token            remove token on logout  [key]
   DEL  /api/users/:uid/tokens       wipe all user tokens    [key]
   POST /api/send                    send to user (fan-out)  [key]
   POST /api/send-to-token           send to raw token       [key]
   POST /api/send-call-cancel        dismiss ringing         [key]
   POST /api/send-missed-call        missed-call alert       [key]
   POST /api/send-multi              up to 500 recipients    [key]
   POST /api/schedule                future delivery         [key]
   POST /api/validate-token          dry-run validity check  [key]
   POST /api/delivery-receipt        client ACK / analytics  [key]
   POST /api/cloudinary/sign         signed upload params      (auth)
   POST /api/cloudinary/destroy      delete asset            [key]

   Required env
   ─────────────────────────────────────────────────────────────
   FIREBASE_SERVICE_ACCOUNT_JSON     full SA JSON string
   -OR- GOOGLE_APPLICATION_CREDENTIALS  path to SA JSON file

   Optional / recommended
   ─────────────────────────────────────────────────────────────
   FIREBASE_DATABASE_URL             RTDB URL (uses project_id if omitted)
   SERVER_API_KEY                    protects [key] endpoints
   RATE_LIMIT_PER_MIN                max sends per uid/min   (default 30)
   PORT                              HTTP port               (default 8080)
   NODE_ENV                          "production"|"development"
   CLOUDINARY_CLOUD_NAME             cloud name              (e.g. dvqqgqdls)
   CLOUDINARY_API_KEY                api key
   CLOUDINARY_API_SECRET             api secret              (NEVER ship to client)
   CLOUDINARY_UPLOAD_FOLDER          folder prefix           (default: callingapp)
   CLOUDINARY_MAX_FILE_MB            max upload size MB      (default: 50)
   ============================================================ */

"use strict";

require("dotenv").config();

const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const compression = require("compression");
const admin       = require("firebase-admin");
const crypto      = require("crypto");

const cloudinaryHelper = require("./cloudinary");

const NODE_ENV   = process.env.NODE_ENV || "development";
const IS_PROD    = NODE_ENV === "production";
const VERSION    = "3.1.0";
const START_TIME = Date.now();

/* ═══════════════════════════════════════════════════════════════
   1. STRUCTURED JSON LOGGER
═══════════════════════════════════════════════════════════════ */
const log = {
  _w(level, msg, meta = {}) {
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), level, msg, svc: "notif-server", v: VERSION, ...meta }) + "\n"
    );
  },
  info:  (m, x) => log._w("INFO",  m, x),
  warn:  (m, x) => log._w("WARN",  m, x),
  error: (m, x) => log._w("ERROR", m, x),
  debug: (m, x) => { if (!IS_PROD) log._w("DEBUG", m, x); },
};

/* ═══════════════════════════════════════════════════════════════
   2. FIREBASE ADMIN INIT
═══════════════════════════════════════════════════════════════ */
(function initAdmin() {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } catch (e) {
      log.error("Bad FIREBASE_SERVICE_ACCOUNT_JSON", { err: e.message });
      process.exit(1);
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credential = admin.credential.applicationDefault();
  } else {
    log.error("No Firebase credentials — set FIREBASE_SERVICE_ACCOUNT_JSON");
    process.exit(1);
  }
  const opts = { credential };
  if (process.env.FIREBASE_DATABASE_URL) opts.databaseURL = process.env.FIREBASE_DATABASE_URL;
  admin.initializeApp(opts);
  log.info("Firebase Admin ready");
})();

const db        = admin.database();
const auth      = admin.auth();
const messaging = admin.messaging();

/* ═══════════════════════════════════════════════════════════════
   2b. CLOUDINARY INIT
═══════════════════════════════════════════════════════════════ */
if (cloudinaryHelper.configure()) {
  log.info("Cloudinary ready", { cloud: cloudinaryHelper.getConfig().cloud_name });
} else {
  log.warn("Cloudinary NOT configured — media upload endpoints disabled. Set CLOUDINARY_* env vars.");
}

/* ═══════════════════════════════════════════════════════════════
   3. METRICS COUNTERS
═══════════════════════════════════════════════════════════════ */
const C = {
  httpRequests:   0,  sent:           0,
  failed:         0,  cancelled:      0,
  missedCalls:    0,  rateLimited:    0,
  retried:        0,  tokensPruned:   0,
  scheduled:      0,  receipts:       0,
  uploadsSigned:  0,  uploadsDeleted: 0,
};

/* ═══════════════════════════════════════════════════════════════
   4. RATE LIMITER  — sliding window per uid
═══════════════════════════════════════════════════════════════ */
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN || "30", 10);
const rateStore  = new Map();

function isRateLimited(uid, bucket = "send") {
  const now   = Date.now();
  const key   = `${bucket}:${uid}`;
  const ts    = (rateStore.get(key) || []).filter(t => now - t < 60_000);
  if (ts.length >= RATE_LIMIT) { C.rateLimited++; rateStore.set(key, ts); return true; }
  ts.push(now);
  rateStore.set(key, ts);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of rateStore)
    if (ts.every(t => now - t > 60_000)) rateStore.delete(k);
}, 5 * 60_000).unref();

/* ═══════════════════════════════════════════════════════════════
   5. IDEMPOTENCY CACHE
═══════════════════════════════════════════════════════════════ */
const idemCache = new Map();
const IDEM_TTL  = 5 * 60_000;

function checkIdem(key) {
  if (!key) return null;
  const hit = idemCache.get(key);
  if (hit && Date.now() - hit.at < IDEM_TTL) return hit.result;
  return null;
}
function setIdem(key, result) {
  if (key) idemCache.set(key, { result, at: Date.now() });
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of idemCache) if (now - v.at > IDEM_TTL) idemCache.delete(k);
}, 60_000).unref();

/* ═══════════════════════════════════════════════════════════════
   6. FCM SEND WITH RETRY
═══════════════════════════════════════════════════════════════ */
const RETRYABLE = new Set([
  "messaging/quota-exceeded",
  "messaging/server-unavailable",
  "messaging/internal-error",
  "messaging/unknown-error",
]);

async function sendWithRetry(message, attempt = 0) {
  try {
    const id = await messaging.send(message);
    C.sent++;
    return { ok: true, messageId: id };
  } catch (err) {
    const code    = err.code || "";
    const expired =
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token";

    if (expired)                            return { ok: false, expired: true, code };
    if (!RETRYABLE.has(code) || attempt >= 4) { C.failed++; return { ok: false, code, err: err.message }; }

    const wait = Math.pow(2, attempt) * 500 + Math.random() * 300;
    C.retried++;
    log.warn("FCM transient — retrying", { code, attempt, wait: Math.round(wait) });
    await new Promise(r => setTimeout(r, wait));
    return sendWithRetry(message, attempt + 1);
  }
}

/* ═══════════════════════════════════════════════════════════════
   7. TOKEN STORE HELPERS
═══════════════════════════════════════════════════════════════ */
function tHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
}

async function getTokens(uid) {
  const snap = await db.ref(`fcmTokens/${uid}`).get();
  if (!snap.exists()) return [];
  return Object.entries(snap.val()).map(([hash, v]) => ({
    hash, token: v.token, platform: v.platform || "android", device: v.deviceName || "?",
  }));
}

async function pruneTokens(uid, hashes) {
  if (!hashes.length) return;
  const up = {};
  for (const h of hashes) up[`fcmTokens/${uid}/${h}`] = null;
  await db.ref().update(up);
  C.tokensPruned += hashes.length;
  log.info("Pruned expired tokens", { uid, count: hashes.length });
}

/* ═══════════════════════════════════════════════════════════════
   8. FAN-OUT
═══════════════════════════════════════════════════════════════ */
async function sendToUser(uid, title, body, data) {
  const tokens = await getTokens(uid);
  if (!tokens.length) return { ok: false, reason: "no_tokens", sent: 0, total: 0 };

  const results = await Promise.all(
    tokens.map(async t => {
      const res = await sendWithRetry(buildMessage(t.token, title, body, data, t.platform));
      return { ...res, hash: t.hash };
    })
  );

  await pruneTokens(uid, results.filter(r => r.expired).map(r => r.hash));

  const sent = results.filter(r => r.ok).length;
  return { ok: sent > 0, sent, total: tokens.length };
}

/* ═══════════════════════════════════════════════════════════════
   9. MESSAGE BUILDER
═══════════════════════════════════════════════════════════════ */
function buildMessage(token, title, body, data, platform = "android") {
  const sd = {};
  if (data && typeof data === "object")
    for (const [k, v] of Object.entries(data)) sd[k] = String(v ?? "");

  const isCall   = sd.type === "call";
  const isCancel = sd.type === "call_cancel";
  const isMissed = sd.type === "missed_call";
  const chatTag  = sd.chatWith || "default";
  const callId   = sd.callId   || chatTag;

  const ttlMs = isCall ? 45_000 : isCancel ? 5_000 : isMissed ? 30 * 60_000 : 60 * 60_000;

  const collapseKey = isCall   ? `call_${callId}`
                    : isCancel ? `cancel_${callId}`
                    : isMissed ? `missed_${callId}`
                    : `chat_${chatTag}`;

  const channelId = isCall || isMissed ? "calls" : "messages";

  return {
    token,
    data: { ...sd, title: title || "", body: body || "" },
    android: {
      priority: "high",
      ttl: ttlMs,
      collapseKey,
      notification: isCancel ? undefined : {
        title:                  title || "",
        body:                   body  || "",
        channelId,
        sound:                  isCall ? "ringtone" : "default",
        tag:                    collapseKey,
        priority:               isCall ? "max" : "high",
        defaultSound:           !isCall,
        defaultVibrateTimings:  !isCall,
        vibrateTimingsMillis:   isCall ? [0, 500, 200, 500, 200, 800] : undefined,
        visibility:             "PUBLIC",
        ticker:                 title || "",
      },
    },
    apns: {
      headers: {
        "apns-priority":    isCall ? "10" : "5",
        "apns-push-type":   "alert",
        "apns-expiration":  String(Math.floor((Date.now() + ttlMs) / 1000)),
        "apns-collapse-id": collapseKey,
      },
      payload: {
        aps: isCancel
          ? { "content-available": 1 }
          : {
              alert:               { title: title || "", body: body || "" },
              sound:               isCall ? "ringtone.caf" : "default",
              "content-available": 1,
              "mutable-content":   1,
              category:            isCall   ? "INCOMING_CALL"
                                 : isMissed ? "MISSED_CALL"
                                            : "MESSAGE",
              "thread-id":         chatTag,
            },
      },
    },
  };
}

/* ═══════════════════════════════════════════════════════════════
   10. SCHEDULED DELIVERY
═══════════════════════════════════════════════════════════════ */
const scheduledJobs = new Map();

function scheduleJob(jobId, deliverAt, fn) {
  const delay = deliverAt - Date.now();
  if (delay <= 0) { fn(); return; }
  const t = setTimeout(() => { scheduledJobs.delete(jobId); fn(); }, delay);
  scheduledJobs.set(jobId, { t });
  C.scheduled++;
}

/* ═══════════════════════════════════════════════════════════════
   11. EXPRESS APP
═══════════════════════════════════════════════════════════════ */
const app = express();

app.use(helmet({
  contentSecurityPolicy: false,        // API server, not serving HTML
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use(compression());

app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: true, exposedHeaders: ["x-request-id"] }));
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  req.rid     = crypto.randomUUID();
  req.startAt = Date.now();
  res.setHeader("x-request-id", req.rid);
  C.httpRequests++;
  log.debug("→", { method: req.method, path: req.path, rid: req.rid });
  res.on("finish", () => {
    log.debug("←", { rid: req.rid, status: res.statusCode, ms: Date.now() - req.startAt });
  });
  next();
});

/* ─── Helpers ──────────────────────────────────────────────── */
function requireKey(req, res, next) {
  const key = process.env.SERVER_API_KEY;
  if (!key) return next();
  if (req.header("x-api-key") !== key) {
    log.warn("Unauthorized", { path: req.path, rid: req.rid });
    return res.status(401).json({ error: "unauthorized", rid: req.rid });
  }
  next();
}

// Verify Firebase ID token sent in `Authorization: Bearer <idToken>`
async function requireFirebaseUser(req, res, next) {
  try {
    const h = req.header("authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "missing_id_token", rid: req.rid });
    req.firebaseUser = await auth.verifyIdToken(m[1]);
    next();
  } catch (e) {
    log.warn("Firebase token verify failed", { err: e.message, rid: req.rid });
    res.status(401).json({ error: "invalid_id_token", rid: req.rid });
  }
}

function ok(res, data = {}) {
  res.json({ ok: true, rid: res.req?.rid, ...data });
}
function err(res, msg, code = 500) {
  log.error(msg, { status: code });
  res.status(code).json({ error: msg, rid: res.req?.rid });
}
function need(req, res, fields) {
  for (const f of fields)
    if (!req.body?.[f]) { err(res, `${f} is required`, 400); return false; }
  return true;
}

/* ═══════════════════════════════════════════════════════════════
   12. ROUTES
═══════════════════════════════════════════════════════════════ */

/* Health ─────────────────────────────────────────────────── */
app.get("/", (_req, res) => ok(res, {
  service: "callingapp-notification-server",
  version: VERSION,
  uptime:  `${Math.floor((Date.now() - START_TIME) / 1000)}s`,
  env:     NODE_ENV,
  features: {
    fcm:        true,
    cloudinary: cloudinaryHelper.isReady(),
  },
}));

app.get("/healthz", async (_req, res) => {
  try {
    await db.ref(".info/connected").get();
    ok(res, { firebase: "connected", cloudinary: cloudinaryHelper.isReady() });
  } catch {
    res.status(503).json({ ok: false, firebase: "disconnected" });
  }
});

/* Stats ──────────────────────────────────────────────────── */
app.get("/api/stats", requireKey, (_req, res) => ok(res, {
  counters: C,
  rateLimitedKeys: rateStore.size,
  scheduledJobs:   scheduledJobs.size,
  idempotencyKeys: idemCache.size,
  uptime:          Math.floor((Date.now() - START_TIME) / 1000),
}));

/* Prometheus metrics ─────────────────────────────────────── */
app.get("/api/metrics", requireKey, (_req, res) => {
  const lines = [
    ...Object.entries(C).map(([k, v]) => `callingapp_${k}_total ${v}`),
    `callingapp_uptime_seconds ${Math.floor((Date.now() - START_TIME) / 1000)}`,
    `callingapp_rate_limited_keys ${rateStore.size}`,
    `callingapp_scheduled_jobs ${scheduledJobs.size}`,
  ];
  res.type("text/plain").send(lines.join("\n") + "\n");
});

/* Register token ─────────────────────────────────────────── */
app.post("/api/register-token", async (req, res) => {
  if (!need(req, res, ["uid", "token"])) return;
  try {
    const { uid, token, platform, deviceName, appVersion } = req.body;
    const hash = tHash(token);
    await db.ref(`fcmTokens/${uid}/${hash}`).set({
      token,
      platform:   platform   || "android",
      deviceName: deviceName || "Unknown",
      appVersion: appVersion || "?",
      updatedAt:  Date.now(),
    });
    log.info("Token registered", { uid, platform: platform || "android", hash });
    ok(res, { hash });
  } catch (e) { err(res, e.message); }
});

/* Delete token ───────────────────────────────────────────── */
app.post("/api/delete-token", requireKey, async (req, res) => {
  if (!need(req, res, ["uid"])) return;
  try {
    const { uid, token } = req.body;
    if (token) await db.ref(`fcmTokens/${uid}/${tHash(token)}`).remove();
    else       await db.ref(`fcmTokens/${uid}`).remove();
    log.info("Token deleted", { uid, partial: !!token });
    ok(res);
  } catch (e) { err(res, e.message); }
});

/* Wipe tokens ────────────────────────────────────────────── */
app.delete("/api/users/:uid/tokens", requireKey, async (req, res) => {
  try {
    await db.ref(`fcmTokens/${req.params.uid}`).remove();
    log.info("All tokens wiped", { uid: req.params.uid });
    ok(res);
  } catch (e) { err(res, e.message); }
});

/* Send to user ───────────────────────────────────────────── */
app.post("/api/send", requireKey, async (req, res) => {
  if (!need(req, res, ["toUid", "title"])) return;
  const { toUid, title, body, data, idempotencyKey } = req.body;

  const cached = checkIdem(idempotencyKey);
  if (cached) return ok(res, { ...cached, cached: true });

  if (isRateLimited(toUid, "send")) return res.status(429).json({ error: "rate_limit_exceeded" });

  try {
    const r = await sendToUser(toUid, title, body, data);
    if (!r.ok && r.reason === "no_tokens") return err(res, "no_token_for_user", 404);
    setIdem(idempotencyKey, r);
    log.info("Sent", { toUid, sent: r.sent, total: r.total });
    ok(res, r);
  } catch (e) { err(res, e.message); }
});

/* Send to raw token ──────────────────────────────────────── */
app.post("/api/send-to-token", requireKey, async (req, res) => {
  if (!need(req, res, ["token", "title"])) return;
  try {
    const { token, title, body, data, platform } = req.body;
    const r = await sendWithRetry(buildMessage(token, title, body, data, platform || "android"));
    ok(res, r);
  } catch (e) { err(res, e.message); }
});

/* Cancel call ────────────────────────────────────────────── */
app.post("/api/send-call-cancel", requireKey, async (req, res) => {
  if (!need(req, res, ["toUid"])) return;
  try {
    const { toUid, callId } = req.body;
    const r = await sendToUser(toUid, "", "", { type: "call_cancel", callId: callId || "" });
    C.cancelled++;
    log.info("Call cancel sent", { toUid, callId });
    ok(res, r);
  } catch (e) { err(res, e.message); }
});

/* Missed call ────────────────────────────────────────────── */
app.post("/api/send-missed-call", requireKey, async (req, res) => {
  if (!need(req, res, ["toUid", "callerName"])) return;
  try {
    const { toUid, callerName, callerEmoji, callId, chatWith } = req.body;
    const r = await sendToUser(
      toUid,
      "Missed Call",
      `${callerEmoji || "📞"} ${callerName} ne call kiya`,
      { type: "missed_call", callerName, callerEmoji: callerEmoji || "📞", callId: callId || "", chatWith: chatWith || toUid }
    );
    C.missedCalls++;
    log.info("Missed call sent", { toUid, callerName });
    ok(res, r);
  } catch (e) { err(res, e.message); }
});

/* Multi-send ─────────────────────────────────────────────── */
app.post("/api/send-multi", requireKey, async (req, res) => {
  if (!Array.isArray(req.body?.toUids) || !req.body?.title)
    return err(res, "toUids[] and title required", 400);

  const { toUids, title, body, data, idempotencyKey } = req.body;
  const cached = checkIdem(idempotencyKey);
  if (cached) return ok(res, { ...cached, cached: true });

  const uids = [...new Set(toUids)].slice(0, 500);
  let totalSent = 0, totalFailed = 0;

  for (let i = 0; i < uids.length; i += 50) {
    await Promise.all(uids.slice(i, i + 50).map(async uid => {
      if (isRateLimited(uid, "send")) return;
      const r = await sendToUser(uid, title, body, data);
      totalSent   += r.sent   || 0;
      totalFailed += (r.total || 0) - (r.sent || 0);
    }));
  }

  const result = { sent: totalSent, failed: totalFailed, recipients: uids.length };
  setIdem(idempotencyKey, result);
  log.info("Multi-send done", result);
  ok(res, result);
});

/* Schedule ───────────────────────────────────────────────── */
app.post("/api/schedule", requireKey, async (req, res) => {
  if (!need(req, res, ["toUid", "title", "deliverAt"])) return;
  const { toUid, title, body, data, deliverAt } = req.body;
  const ts = new Date(deliverAt).getTime();
  if (isNaN(ts)) return err(res, "deliverAt must be a valid ISO timestamp", 400);

  if (ts <= Date.now()) {
    const r = await sendToUser(toUid, title, body, data);
    return ok(res, { ...r, deliveredImmediately: true });
  }

  const jobId = crypto.randomUUID();
  scheduleJob(jobId, ts, async () => {
    const r = await sendToUser(toUid, title, body, data);
    log.info("Scheduled delivery complete", { jobId, toUid, ...r });
  });

  ok(res, { jobId, deliverAt, delayMs: ts - Date.now() });
});

/* Validate token ─────────────────────────────────────────── */
app.post("/api/validate-token", requireKey, async (req, res) => {
  if (!need(req, res, ["token"])) return;
  try {
    await messaging.send({ token: req.body.token, data: { _v: "1" } }, true);
    ok(res, { valid: true });
  } catch (e) {
    const invalid =
      e.code === "messaging/registration-token-not-registered" ||
      e.code === "messaging/invalid-registration-token";
    ok(res, { valid: !invalid, code: e.code });
  }
});

/* Delivery receipt ───────────────────────────────────────── */
app.post("/api/delivery-receipt", requireKey, async (req, res) => {
  const { uid, messageId, event } = req.body || {};
  if (!uid || !messageId) return err(res, "uid and messageId required", 400);
  try {
    await db.ref(`deliveryReceipts/${uid}/${messageId.replace(/\//g, "_")}`).set({
      event: event || "received", at: Date.now(),
    });
    C.receipts++;
    ok(res);
  } catch (e) { err(res, e.message); }
});

/* ═══════════════════════════════════════════════════════════════
   13. CLOUDINARY ROUTES
═══════════════════════════════════════════════════════════════ */

/* Sign upload params — auth via Firebase ID token (no shared key)
   Body: { chatId: string, kind: "image"|"video"|"audio"|"voice"|"file" } */
app.post("/api/cloudinary/sign", requireFirebaseUser, (req, res) => {
  if (!cloudinaryHelper.isReady()) return err(res, "cloudinary_not_configured", 503);
  try {
    const uid    = req.firebaseUser.uid;
    if (isRateLimited(uid, "upload")) return res.status(429).json({ error: "rate_limit_exceeded" });

    const chatId = req.body?.chatId || "general";
    const kind   = (req.body?.kind || "file").toLowerCase();

    const params = cloudinaryHelper.signUploadParams({ uid, chatId, kind });
    C.uploadsSigned++;
    log.info("Upload signed", { uid, chatId, kind, public_id: params.public_id });
    ok(res, params);
  } catch (e) { err(res, e.message, 400); }
});

/* Destroy asset — admin only */
app.post("/api/cloudinary/destroy", requireKey, async (req, res) => {
  if (!cloudinaryHelper.isReady()) return err(res, "cloudinary_not_configured", 503);
  if (!need(req, res, ["public_id"])) return;
  try {
    const r = await cloudinaryHelper.destroyAsset(
      req.body.public_id,
      req.body.resource_type || "image"
    );
    C.uploadsDeleted++;
    log.info("Asset destroyed", { public_id: req.body.public_id });
    ok(res, { result: r });
  } catch (e) { err(res, e.message); }
});

/* 404 + global error ─────────────────────────────────────── */
app.use((_req, res)        => err(res, "not_found", 404));
app.use((e, _q, res, _n)   => { log.error("Unhandled", { err: e.message }); err(res, "internal_error"); });

/* ═══════════════════════════════════════════════════════════════
   14. SERVER START + GRACEFUL SHUTDOWN
═══════════════════════════════════════════════════════════════ */
const PORT   = parseInt(process.env.PORT || "8080", 10);
const server = app.listen(PORT, () =>
  log.info(`Listening on :${PORT}`, { env: NODE_ENV, version: VERSION })
);

function shutdown(sig) {
  log.info(`${sig} — shutting down`);
  for (const { t } of scheduledJobs.values()) clearTimeout(t);
  server.close(() => { log.info("HTTP closed"); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("uncaughtException",  e => log.error("uncaughtException",  { err: e.message, stack: e.stack }));
process.on("unhandledRejection", e => log.error("unhandledRejection", { err: String(e) }));

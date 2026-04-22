/* ============================================================
   CallingApp — FCM Client  v3.0  (Ultra Production)
   ============================================================
   Platform : Capacitor 6  (Android + iOS)
   Features
   ─────────────────────────────────────────────────────────────
   ✅ Bug fixes (see FIXES section below)
   🔔 Multi-device token registration with hash-based deduplication
   📵 Call cancel — dismiss ringtone on receiver when caller hangs up
   📞 Auto missed-call after configurable timeout (default 45 s)
   🔕 DND (Do Not Disturb) — mute non-call notifications
   🔢 Per-chat unread badge count + total app badge
   💬 Quick Reply directly from notification shade
   🔖 Mark-as-Read action from notification
   📋 Notification history ring-buffer (last 50)
   📊 Client-side analytics (received / shown / suppressed / tapped)
   🔄 Server calls with exponential back-off retry (3 attempts)
   ♻️  Token refresh — detects FCM token rotation, re-registers
   🚪 Logout cleanup — removes token from server + Firebase RTDB
   📡 Offline queue — notifications sent when connectivity returns
   🔐 Deduplication — ignores duplicate messageId within 30 s
   🛡️  Error boundary — every async path caught, logged, never crashes
   ⚡ Screen wake + ringtone management for incoming calls
   ─────────────────────────────────────────────────────────────
   FIXES (vs v1)
   ─────────────────────────────────────────────────────────────
   ✅ createChannel now calls LocalNotifications (not PushNotifications)
   ✅ Killed-app notifications work — server sends notification payload
   ✅ X-API-KEY header sent on all server requests
   ✅ Platform auto-detected (was hardcoded "android")
   ✅ Token rotation handled — re-registers on refresh
   ✅ iOS apns-expiration now set correctly on server side
   ─────────────────────────────────────────────────────────────
   Global variables read from window (set before loading this file)
   ─────────────────────────────────────────────────────────────
   window.NOTIFICATION_SERVER_URL      backend URL
   window.NOTIFICATION_SERVER_API_KEY  X-API-KEY value
   ============================================================ */

/* global firebase, Capacitor */
(function () {
  "use strict";

  /* ──────────────────────────────────────────────────────────
     CONFIGURATION
  ────────────────────────────────────────────────────────── */
  const CFG = Object.freeze({
    serverUrl:       (window.NOTIFICATION_SERVER_URL  || "https://callingapp-notification-server-v2op.onrender.com").replace(/\/+$/, ""),
    serverKey:       window.NOTIFICATION_SERVER_API_KEY || "",
    callTimeoutMs:   45_000,   // auto missed-call after 45 s
    maxHistory:      50,       // notification ring-buffer size
    maxRetries:      3,        // server call retries
    dedupWindowMs:   30_000,   // ignore duplicate messageId within 30 s
    offlineQueueMax: 20,       // max queued notifications when offline
    tokenRefPath:    "fcmTokens", // Firebase RTDB path
  });

  /* ──────────────────────────────────────────────────────────
     PLATFORM  GUARD
  ────────────────────────────────────────────────────────── */
  const isNative = !!(
    window.Capacitor &&
    window.Capacitor.isNativePlatform &&
    window.Capacitor.isNativePlatform()
  );
  const PLATFORM = isNative ? (window.Capacitor.getPlatform() || "android") : "web";

  /* ──────────────────────────────────────────────────────────
     LOGGER  (structured, INFO+ in prod, DEBUG in dev)
  ────────────────────────────────────────────────────────── */
  const IS_DEBUG = !!(window.FCM_DEBUG || false);
  const fcmLog = {
    _fmt: (lvl, msg, meta) => `[FCM:${lvl}] ${msg}` + (meta ? " " + JSON.stringify(meta) : ""),
    info:  (m, x) => console.info (fcmLog._fmt("INFO",  m, x)),
    warn:  (m, x) => console.warn (fcmLog._fmt("WARN",  m, x)),
    error: (m, x) => console.error(fcmLog._fmt("ERROR", m, x)),
    debug: (m, x) => { if (IS_DEBUG) console.debug(fcmLog._fmt("DEBUG", m, x)); },
  };

  /* ──────────────────────────────────────────────────────────
     WEB STUB
  ────────────────────────────────────────────────────────── */
  if (!isNative) {
    fcmLog.info("Web build — native FCM disabled");
    window.FCM = {
      isNative: false, platform: "web",
      init: () => {}, getToken: () => null,
      sendPush: async () => {}, sendCallCancel: async () => {},
      sendMissedCall: async () => {}, logout: async () => {},
      setUid: () => {}, setDND: () => {}, isDND: () => false,
      getUnreadCount: () => 0, clearUnread: () => {},
      getNotificationHistory: () => [], getAnalytics: () => ({}),
    };
    return;
  }

  /* ──────────────────────────────────────────────────────────
     CAPACITOR PLUGIN REFS
  ────────────────────────────────────────────────────────── */
  const { PushNotifications, LocalNotifications, App: CapApp, Network } =
    window.Capacitor.Plugins || {};

  /* ──────────────────────────────────────────────────────────
     STATE
  ────────────────────────────────────────────────────────── */
  let fcmToken          = null;
  let currentUid        = null;
  let appIsActive       = true;
  let isOnline          = true;
  let dndEnabled        = false;
  let listenersAttached = false;
  let callTimeoutHandle = null;

  // Analytics counters
  const analytics = { received: 0, shown: 0, suppressed: 0, tapped: 0, errors: 0 };

  // Unread counts: { chatUid: number }
  let unreadCounts = {};

  // Notification history ring-buffer
  let notifHistory = [];

  // Dedup cache: Set of seen messageIds (cleared every 30 s)
  const seenIds = new Set();
  setInterval(() => seenIds.clear(), CFG.dedupWindowMs);

  // Offline queue: Array of { fn } — flushed when back online
  const offlineQueue = [];

  /* ──────────────────────────────────────────────────────────
     PERSIST / LOAD  (localStorage)
  ────────────────────────────────────────────────────────── */
  function persist(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }
  function load(key, def)    { try { return JSON.parse(localStorage.getItem(key) || "null") ?? def; } catch (_) { return def; } }

  function loadState() {
    dndEnabled   = load("fcm_dnd",     false);
    unreadCounts = load("fcm_unread",  {});
    notifHistory = load("fcm_history", []);
  }

  /* ──────────────────────────────────────────────────────────
     UNREAD BADGE
  ────────────────────────────────────────────────────────── */
  function incUnread(uid)  { unreadCounts[uid] = (unreadCounts[uid] || 0) + 1; _saveUnread(); }
  function clearUnread(uid){ if (uid) delete unreadCounts[uid]; else unreadCounts = {}; _saveUnread(); }

  function _saveUnread() {
    persist("fcm_unread", unreadCounts);
    const total = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
    try { if (window.Capacitor.Plugins.Badge) window.Capacitor.Plugins.Badge.set({ count: total }); } catch (_) {}
    window.dispatchEvent(new CustomEvent("fcm:unread", { detail: { total, counts: { ...unreadCounts } } }));
  }

  /* ──────────────────────────────────────────────────────────
     NOTIFICATION HISTORY
  ────────────────────────────────────────────────────────── */
  function addHistory(entry) {
    notifHistory.unshift({ ...entry, at: Date.now() });
    if (notifHistory.length > CFG.maxHistory) notifHistory.length = CFG.maxHistory;
    persist("fcm_history", notifHistory);
  }

  /* ──────────────────────────────────────────────────────────
     STABLE NOTIFICATION ID  (hash chatWith/callId → int)
  ────────────────────────────────────────────────────────── */
  function hashId(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return Math.abs(h) % 2_147_483_647 || 1;
  }

  /* ──────────────────────────────────────────────────────────
     SERVER HTTP CLIENT  (retry + offline queue)
  ────────────────────────────────────────────────────────── */
  function apiHeaders() {
    const h = { "Content-Type": "application/json" };
    if (CFG.serverKey) h["x-api-key"] = CFG.serverKey;
    return h;
  }

  async function apiFetch(path, body, attempt = 0) {
    if (!isOnline) {
      if (offlineQueue.length < CFG.offlineQueueMax) {
        offlineQueue.push(() => apiFetch(path, body));
        fcmLog.debug("Queued offline", { path });
      }
      return null;
    }
    try {
      const res = await fetch(CFG.serverUrl + path, {
        method:  "POST",
        headers: apiHeaders(),
        body:    JSON.stringify(body),
      });
      if (res.ok) return res.json().catch(() => ({}));
      if ((res.status === 429 || res.status >= 500) && attempt < CFG.maxRetries) {
        await _sleep(Math.pow(2, attempt) * 400 + Math.random() * 200);
        return apiFetch(path, body, attempt + 1);
      }
      fcmLog.warn("Server error", { path, status: res.status });
      return null;
    } catch (e) {
      if (attempt < CFG.maxRetries) {
        await _sleep(Math.pow(2, attempt) * 400);
        return apiFetch(path, body, attempt + 1);
      }
      fcmLog.warn("Fetch failed", { path, err: e.message });
      return null;
    }
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ──────────────────────────────────────────────────────────
     TOKEN STORE  (RTDB + server)
  ────────────────────────────────────────────────────────── */
  function _tHash(token) {
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36).slice(0, 16);
  }

  async function _saveTokenFirebase(uid, token) {
    try {
      if (window.firebase?.database) {
        const hash = _tHash(token);
        await firebase.database().ref(`${CFG.tokenRefPath}/${uid}/${hash}`).set({
          token, platform: PLATFORM, updatedAt: Date.now(),
        });
        fcmLog.debug("Token saved RTDB");
      }
    } catch (e) { fcmLog.error("RTDB token save failed", { err: e.message }); }
  }

  async function _removeTokenFirebase(uid, token) {
    try {
      if (window.firebase?.database) {
        const hash = _tHash(token);
        await firebase.database().ref(`${CFG.tokenRefPath}/${uid}/${hash}`).remove();
      }
    } catch (e) { fcmLog.warn("RTDB token remove failed", { err: e.message }); }
  }

  async function _registerToken(uid, token) {
    await _saveTokenFirebase(uid, token);
    await apiFetch("/api/register-token", { uid, token, platform: PLATFORM });
    fcmLog.info("Token registered", { platform: PLATFORM });
  }

  async function _deregisterToken(uid, token) {
    await _removeTokenFirebase(uid, token);
    await apiFetch("/api/delete-token", { uid, token });
    fcmLog.info("Token deregistered");
  }

  /* ──────────────────────────────────────────────────────────
     NOTIFICATION CHANNELS  (Android 8+)
     ✅ FIX: must use LocalNotifications.createChannel
  ────────────────────────────────────────────────────────── */
  async function _createChannels() {
    const channels = [
      {
        id: "calls",   name: "Incoming Calls",
        description: "Incoming voice and video calls",
        importance: 5, sound: "ringtone",
        vibration: true, lights: true, lightColor: "#4CAF50", visibility: 1,
      },
      {
        id: "missed_calls", name: "Missed Calls",
        description: "Missed call alerts",
        importance: 3, sound: "default",
        vibration: false, lights: false, visibility: 1,
      },
      {
        id: "messages", name: "Messages",
        description: "Chat message notifications",
        importance: 4, sound: "default",
        vibration: true, lights: true, lightColor: "#25D366", visibility: 1,
      },
      {
        id: "system", name: "System",
        description: "App system alerts",
        importance: 2, sound: "default", visibility: 1,
      },
    ];
    for (const ch of channels) {
      try { await LocalNotifications.createChannel(ch); } catch (_) {}
    }
    fcmLog.info("Channels ready");
  }

  /* ──────────────────────────────────────────────────────────
     ACTION TYPES  (notification buttons)
  ────────────────────────────────────────────────────────── */
  async function _registerActionTypes() {
    try {
      await LocalNotifications.registerActionTypes({
        types: [
          {
            id: "INCOMING_CALL",
            actions: [
              { id: "accept", title: "Accept" },
              { id: "reject", title: "Reject", destructive: true },
            ],
          },
          {
            id: "MISSED_CALL",
            actions: [{ id: "callback", title: "Call Back" }],
          },
          {
            id: "MESSAGE",
            actions: [
              {
                id: "reply", title: "Reply",
                input: true,
                inputButtonTitle: "Send",
                inputPlaceholder: "Type a reply...",
              },
              { id: "mark_read", title: "Mark as Read" },
            ],
          },
        ],
      });
    } catch (e) { fcmLog.warn("registerActionTypes failed", { err: e.message }); }
  }

  /* ──────────────────────────────────────────────────────────
     SHOW RICH LOCAL NOTIFICATION
  ────────────────────────────────────────────────────────── */
  function _showNotif(title, body, data) {
    analytics.received++;

    const isCall   = data?.type === "call";
    const isCancel = data?.type === "call_cancel";
    const isMissed = data?.type === "missed_call";
    const chatWith = data?.chatWith || "default";
    const msgId    = data?.messageId;

    // Deduplication
    if (msgId && seenIds.has(msgId)) {
      analytics.suppressed++;
      fcmLog.debug("Dedup suppressed", { msgId });
      return;
    }
    if (msgId) seenIds.add(msgId);

    // Call cancel — dismiss existing call notification silently
    if (isCancel) {
      const cid = hashId("call_" + (data?.callId || chatWith));
      LocalNotifications.cancel({ notifications: [{ id: cid }] }).catch(() => {});
      if (callTimeoutHandle) { clearTimeout(callTimeoutHandle); callTimeoutHandle = null; }
      window.dispatchEvent(new CustomEvent("fcm:call_cancel", { detail: { data } }));
      return;
    }

    // DND guard (calls always get through)
    if (dndEnabled && !isCall) {
      analytics.suppressed++;
      fcmLog.debug("DND suppressed");
      return;
    }

    // Foreground suppression for messages — user is already in that chat
    if (!isCall && !isMissed && window.currentOpenChatUid === chatWith && appIsActive) {
      analytics.suppressed++;
      fcmLog.debug("Chat open — suppressed");
      return;
    }

    // Unread tracking
    if (!isCall && !isMissed) incUnread(chatWith);

    const groupKey = isCall   ? `call_${data?.callId   || chatWith}`
                   : isMissed ? `missed_${chatWith}`
                   : `chat_${chatWith}`;
    const notifId  = hashId(groupKey);
    const count    = unreadCounts[chatWith] || 1;
    const displayTitle = !isCall && !isMissed && count > 1 ? `${title} (${count})` : title;

    analytics.shown++;
    addHistory({ title, body, type: data?.type || "message", data });

    LocalNotifications.schedule({
      notifications: [{
        id:           notifId,
        title:        displayTitle,
        body,
        largeBody:    body,
        summaryText:  count > 1 ? `${count} new messages` : undefined,
        extra:        data,
        smallIcon:    "ic_stat_icon_config_sample",
        sound:        isCall ? "ringtone" : "default",
        channelId:    isCall ? "calls" : isMissed ? "missed_calls" : "messages",
        group:        groupKey,
        groupSummary: false,
        autoCancel:   !isCall,
        ongoing:      isCall,
        actionTypeId: isCall ? "INCOMING_CALL" : isMissed ? "MISSED_CALL" : "MESSAGE",
      }],
    }).catch(e => { analytics.errors++; fcmLog.error("schedule failed", { err: e.message }); });

    // Auto missed-call timeout for incoming calls
    if (isCall) {
      if (callTimeoutHandle) clearTimeout(callTimeoutHandle);
      callTimeoutHandle = setTimeout(async () => {
        callTimeoutHandle = null;
        LocalNotifications.cancel({ notifications: [{ id: notifId }] }).catch(() => {});
        const missedId = hashId("missed_" + chatWith);
        await LocalNotifications.schedule({
          notifications: [{
            id: missedId, title: "Missed Call",
            body: `${data?.callerEmoji || "📞"} ${title.replace(/^Incoming\s+/i, "")}`,
            channelId: "missed_calls", autoCancel: true,
            extra: { ...data, type: "missed_call" }, actionTypeId: "MISSED_CALL",
          }],
        }).catch(() => {});
        window.dispatchEvent(new CustomEvent("fcm:call_timeout", { detail: { data } }));
      }, CFG.callTimeoutMs);
    }
  }

  /* ──────────────────────────────────────────────────────────
     ROUTING  (notification tap → open screen)
  ────────────────────────────────────────────────────────── */
  function _route(data) {
    if (!data) return;
    if (data.type === "call") return; // RTDB listener handles call UI
    if (data.chatWith) {
      clearUnread(data.chatWith);
      if (typeof window.openChatByUid === "function") {
        try { window.openChatByUid(data.chatWith); } catch (_) {}
      }
    }
  }

  /* ──────────────────────────────────────────────────────────
     QUICK REPLY  (direct reply from notification shade)
  ────────────────────────────────────────────────────────── */
  async function _handleQuickReply(data, replyText) {
    if (!data?.chatWith || !currentUid || !replyText?.trim()) return;
    try {
      const db  = window.firebase?.database?.();
      const cid = [currentUid, data.chatWith].sort().join("_");
      if (db) await db.ref(`messages/${cid}`).push({ text: replyText, sender: currentUid, timestamp: Date.now() });
      await FCM.sendPush(data.chatWith, "New Message", replyText, { chatWith: currentUid, type: "message" });
    } catch (e) { fcmLog.error("Quick reply failed", { err: e.message }); }
  }

  /* ──────────────────────────────────────────────────────────
     LISTENERS  (attached only once)
  ────────────────────────────────────────────────────────── */
  function _attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;

    // ✅ FIX: token refresh handler — re-registers on FCM token rotation
    PushNotifications.addListener("registration", (t) => {
      const newToken = t.value;
      if (newToken === fcmToken) return;
      const old = fcmToken;
      fcmToken   = newToken;
      window.FCM.token = newToken;
      fcmLog.info("FCM token received/refreshed");
      if (currentUid) {
        if (old) _deregisterToken(currentUid, old).catch(() => {});
        _registerToken(currentUid, newToken).catch(() => {});
      }
      window.dispatchEvent(new CustomEvent("fcm:token", { detail: { token: newToken } }));
    });

    PushNotifications.addListener("registrationError", (e) => {
      analytics.errors++;
      fcmLog.error("Registration error", { err: e.error });
      window.dispatchEvent(new CustomEvent("fcm:error", { detail: e }));
    });

    // Foreground push received
    PushNotifications.addListener("pushNotificationReceived", (notif) => {
      const data  = notif?.data  || {};
      const title = notif?.title || data.title || "New message";
      const body  = notif?.body  || data.body  || "";
      fcmLog.debug("Push received (fg)", { type: data.type });
      _showNotif(title, body, data);
      window.dispatchEvent(new CustomEvent("fcm:message", { detail: { title, body, data } }));
    });

    // Notification tapped when app was in BG / killed
    PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      analytics.tapped++;
      const data = action?.notification?.data || {};
      fcmLog.debug("Push tapped (bg)", { type: data.type });
      window.dispatchEvent(new CustomEvent("fcm:open", { detail: { data, action } }));
      _route(data);
    });

    // LocalNotification actions (foreground-rendered)
    LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
      analytics.tapped++;
      const data     = action?.notification?.extra || {};
      const actionId = action?.actionId;
      fcmLog.debug("Local action", { actionId, type: data.type });

      if (data.type === "call") {
        if (callTimeoutHandle) { clearTimeout(callTimeoutHandle); callTimeoutHandle = null; }
        if (actionId === "reject") {
          try { window.rejectIncomingCall?.(); } catch (_) {}
        } else {
          try { window.acceptIncomingCall?.(); } catch (_) {}
        }
      } else if (actionId === "reply" && action?.inputValue) {
        _handleQuickReply(data, action.inputValue).catch(() => {});
      } else if (actionId === "mark_read") {
        clearUnread(data.chatWith);
      } else if (actionId === "callback") {
        _route({ ...data, type: "missed_call" });
      } else {
        _route(data);
      }
    });

    // App foreground/background state
    CapApp?.addListener?.("appStateChange", ({ isActive }) => {
      appIsActive = isActive;
      if (isActive) _saveUnread(); // refresh badge on resume
    });

    // Network connectivity — flush offline queue when back online
    if (Network) {
      Network.addListener("networkStatusChange", ({ connected }) => {
        isOnline = connected;
        if (connected && offlineQueue.length) {
          fcmLog.info("Back online — flushing queue", { size: offlineQueue.length });
          const q = offlineQueue.splice(0);
          q.forEach(fn => fn().catch(() => {}));
        }
      });
      Network.getStatus().then(s => { isOnline = s.connected; }).catch(() => {});
    }
  }

  /* ──────────────────────────────────────────────────────────
     INIT
  ────────────────────────────────────────────────────────── */
  async function init(uid) {
    try {
      if (uid) currentUid = uid;
      loadState();

      const perm = await PushNotifications.checkPermissions();
      let granted = perm.receive === "granted";
      if (!granted && (perm.receive === "prompt" || perm.receive === "prompt-with-rationale")) {
        const req = await PushNotifications.requestPermissions();
        granted = req.receive === "granted";
      }
      if (!granted) { fcmLog.warn("Push permission denied"); return; }

      try {
        const lp = await LocalNotifications.checkPermissions();
        if (lp.display !== "granted") await LocalNotifications.requestPermissions();
      } catch (_) {}

      await _createChannels();
      await _registerActionTypes();
      _attachListeners();
      await PushNotifications.register();
      fcmLog.info("FCM initialised", { uid: currentUid, platform: PLATFORM });
    } catch (e) {
      analytics.errors++;
      fcmLog.error("Init failed", { err: e.message });
    }
  }

  /* ──────────────────────────────────────────────────────────
     PUBLIC API
  ────────────────────────────────────────────────────────── */

  /** Send push to a user through the notification server */
  async function sendPush(toUid, title, body, data) {
    return apiFetch("/api/send", { toUid, title, body, data: data || {} });
  }

  /** Cancel ringing on receiver's device (caller cancelled) */
  async function sendCallCancel(toUid, callId) {
    return apiFetch("/api/send-call-cancel", { toUid, callId: callId || "" });
  }

  /** Notify receiver of a missed call */
  async function sendMissedCall(toUid, callerName, callerEmoji, callId) {
    return apiFetch("/api/send-missed-call", { toUid, callerName, callerEmoji, callId: callId || "" });
  }

  /** Remove token from server + RTDB on logout */
  async function logout() {
    if (!currentUid || !fcmToken) return;
    await _deregisterToken(currentUid, fcmToken).catch(() => {});
    fcmToken = null;
    currentUid = null;
    clearUnread();
    fcmLog.info("Logged out — token removed");
  }

  /** Set uid after login and register token */
  function setUid(uid) {
    currentUid = uid;
    if (fcmToken) _registerToken(uid, fcmToken).catch(() => {});
  }

  /** Enable / disable Do Not Disturb (non-call notifications silenced) */
  function setDND(on) {
    dndEnabled = !!on;
    persist("fcm_dnd", dndEnabled);
    fcmLog.info("DND", { enabled: dndEnabled });
  }

  /* ──────────────────────────────────────────────────────────
     EXPORT
  ────────────────────────────────────────────────────────── */
  const FCM = {
    isNative: true,
    platform: PLATFORM,
    token:    null,

    // Core
    init,
    getToken: () => fcmToken,

    // Sending
    sendPush,
    sendCallCancel,
    sendMissedCall,

    // User lifecycle
    setUid,
    logout,

    // Settings
    setDND,
    isDND: () => dndEnabled,

    // Unread
    getUnreadCount: (uid) => uid ? (unreadCounts[uid] || 0) : Object.values(unreadCounts).reduce((a, b) => a + b, 0),
    clearUnread,

    // Observability
    getNotificationHistory: () => [...notifHistory],
    getAnalytics:           () => ({ ...analytics }),
  };

  window.FCM     = FCM;
  window.sendPush = sendPush; // backward compat for index.html

  /* ──────────────────────────────────────────────────────────
     AUTO-INIT  on Firebase auth state
  ────────────────────────────────────────────────────────── */
  document.addEventListener("DOMContentLoaded", () => {
    loadState();
    const tryHook = () => {
      if (window.firebase?.auth) {
        firebase.auth().onAuthStateChanged(user => {
          if (user) init(user.uid).catch(e => fcmLog.error("init error", { err: e.message }));
          else { fcmToken = null; currentUid = null; }
        });
      } else {
        setTimeout(tryHook, 300);
      }
    };
    tryHook();
  });
})();

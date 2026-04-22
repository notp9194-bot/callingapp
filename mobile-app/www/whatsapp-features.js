/* ============================================================
   CallingApp — WhatsApp-clone feature pack  v1.0
   ============================================================
   Adds on top of the existing index.html app:
     • Media messages: image / video / audio / file / voice notes
     • Voice-note recording (MediaRecorder → Cloudinary)
     • Read receipts (✓ / ✓✓ / ✓✓ blue)
     • Typing indicators
     • Online / last-seen presence (RTDB onDisconnect)
     • Profile photo (Cloudinary)
     • Message reactions (emoji long-press / dbl-click)
     • Reply-to + delete-for-me
     • Status / Stories (24h auto-expire client-side filter)
     • Push notifications for media messages
   ============================================================
   Requires (loaded in index.html BEFORE this script):
     - firebase compat SDK + firebaseConfig + auth/db
     - cloudinary.js (window.MediaUploader)
     - fcm.js     (window.sendPush)
   ============================================================ */
(function () {
  "use strict";

  /* ---------- wait for the main app to be ready ---------- */
  function whenReady(cb) {
    const iv = setInterval(() => {
      if (window.firebase?.auth && window.firebase?.database
          && window.MediaUploader
          && document.getElementById("chat-input-container")) {
        clearInterval(iv);
        cb();
      }
    }, 80);
  }

  whenReady(initFeatures);

  /* ════════════════════════════════════════════════════════
     STYLES
  ════════════════════════════════════════════════════════ */
  const css = `
    .wa-attach-btn,.wa-mic-btn,.wa-emoji-btn{
      background:transparent;border:0;padding:6px;cursor:pointer;color:#54656f;
      display:flex;align-items:center;justify-content:center;
    }
    .wa-attach-btn svg,.wa-mic-btn svg,.wa-emoji-btn svg{width:24px;height:24px;fill:currentColor}
    .wa-mic-btn.recording{color:#dc3545;animation:wa-pulse 1s infinite;}
    @keyframes wa-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}
    .wa-attach-menu{
      position:absolute;bottom:64px;left:8px;background:#fff;border-radius:12px;
      box-shadow:0 6px 24px rgba(0,0,0,.18);padding:8px;display:none;z-index:50;
      grid-template-columns:repeat(3,72px);gap:8px;
    }
    .wa-attach-menu.open{display:grid}
    .wa-attach-item{
      background:#f0f2f5;border:0;padding:10px 6px;border-radius:10px;cursor:pointer;
      display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;color:#3b4a54;
    }
    .wa-attach-item .ico{font-size:22px}
    .message-bubble{position:relative;max-width:80%;padding:6px 9px;margin:4px 8px;word-wrap:break-word;}
    .message-bubble.has-media{padding:4px;}
    .wa-msg-meta{display:flex;justify-content:flex-end;align-items:center;gap:4px;font-size:11px;color:#667781;margin-top:2px;}
    .wa-tick{font-size:14px;line-height:1;}
    .wa-tick.read{color:#53bdeb;}
    .wa-img,.wa-video{max-width:260px;max-height:340px;border-radius:8px;display:block;cursor:pointer;background:#000;}
    .wa-audio{width:240px;display:block;}
    .wa-file{
      display:flex;align-items:center;gap:10px;padding:8px;background:rgba(0,0,0,.04);
      border-radius:8px;text-decoration:none;color:#111;min-width:200px;
    }
    .wa-file .ico{font-size:28px}
    .wa-file .meta{display:flex;flex-direction:column;font-size:13px;}
    .wa-file .meta small{color:#667781;font-size:11px;}
    .wa-reactions{display:inline-flex;gap:2px;background:#fff;border-radius:12px;
      padding:1px 6px;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.15);
      position:absolute;bottom:-10px;right:8px;}
    .wa-reply-quote{
      border-left:3px solid #25d366;background:rgba(0,0,0,.04);padding:4px 8px;
      border-radius:6px;margin-bottom:4px;font-size:12px;color:#444;
    }
    .wa-typing{font-size:12px;color:#25d366;font-style:italic;padding:4px 12px;height:18px;}
    .wa-presence{font-size:12px;color:#667781;}
    .wa-uploading{
      display:flex;align-items:center;gap:8px;padding:8px;background:rgba(0,0,0,.04);
      border-radius:8px;font-size:13px;color:#444;min-width:200px;
    }
    .wa-progress{height:4px;background:#e9edef;border-radius:2px;overflow:hidden;flex:1;}
    .wa-progress > i{display:block;height:100%;background:#25d366;width:0%;transition:width .15s;}
    .wa-mediaviewer{
      position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9999;display:none;
      align-items:center;justify-content:center;padding:20px;
    }
    .wa-mediaviewer.open{display:flex}
    .wa-mediaviewer img,.wa-mediaviewer video{max-width:100%;max-height:100%;border-radius:6px;}
    .wa-mediaviewer .close{position:absolute;top:16px;right:16px;background:#0008;color:#fff;
      border:0;width:36px;height:36px;border-radius:50%;font-size:18px;cursor:pointer;}
    .wa-react-picker{
      position:absolute;background:#fff;border-radius:24px;padding:6px 10px;
      box-shadow:0 4px 16px rgba(0,0,0,.2);display:none;gap:6px;z-index:60;
    }
    .wa-react-picker.open{display:flex}
    .wa-react-picker button{background:none;border:0;font-size:22px;cursor:pointer;}
    .wa-reply-bar{
      display:none;background:#f0f2f5;padding:6px 10px;border-left:3px solid #25d366;
      align-items:center;justify-content:space-between;font-size:13px;color:#444;
    }
    .wa-reply-bar.open{display:flex}
    .wa-reply-bar button{background:none;border:0;font-size:18px;cursor:pointer;color:#666;}
  `;
  function injectStyles(){ const s=document.createElement("style"); s.textContent=css; document.head.appendChild(s); }

  /* ════════════════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════════════════ */
  let auth, db;
  let currentUid = null;
  let openChatPartner = null;        // { uid, name, emoji, photoUrl? }
  let openChatId = null;
  let messageNodeMap = new Map();    // msgId → DOM node
  let activeReplyTo = null;
  let typingTimer = null;
  let lastTypingPing = 0;

  function initFeatures() {
    injectStyles();
    auth = window.firebase.auth();
    db   = window.firebase.database();

    auth.onAuthStateChanged((u) => {
      if (!u) { currentUid = null; return; }
      currentUid = u.uid;
      setupPresence(u.uid);
    });

    upgradeChatInputUI();
    upgradeChatHeaderUI();
    hookOpenChat();
    hookSendButton();
    hookProfilePhotoUpload();
    buildMediaViewer();
    buildReactionPicker();
    console.log("[WhatsApp Features] initialised");
  }

  /* ════════════════════════════════════════════════════════
     PRESENCE  (online + last-seen)
  ════════════════════════════════════════════════════════ */
  function setupPresence(uid) {
    const conRef    = db.ref(".info/connected");
    const statusRef = db.ref(`presence/${uid}`);
    conRef.on("value", (snap) => {
      if (!snap.val()) return;
      statusRef.onDisconnect().set({ state: "offline", lastSeen: window.firebase.database.ServerValue.TIMESTAMP });
      statusRef.set({ state: "online", lastSeen: window.firebase.database.ServerValue.TIMESTAMP });
    });
  }

  function watchPartnerPresence(uid, onChange) {
    const ref = db.ref(`presence/${uid}`);
    const cb  = (snap) => onChange(snap.val() || { state: "offline" });
    ref.on("value", cb);
    return () => ref.off("value", cb);
  }

  function fmtLastSeen(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const today = new Date(); today.setHours(0,0,0,0);
    const dDay  = new Date(d);   dDay.setHours(0,0,0,0);
    const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (dDay.getTime() === today.getTime()) return `last seen today at ${t}`;
    if (today.getTime() - dDay.getTime() === 86400000) return `last seen yesterday at ${t}`;
    return `last seen ${d.toLocaleDateString()} at ${t}`;
  }

  /* ════════════════════════════════════════════════════════
     CHAT INPUT  — attach + emoji + voice-note
  ════════════════════════════════════════════════════════ */
  function upgradeChatInputUI() {
    const c = document.getElementById("chat-input-container");
    if (!c || c.dataset.upgraded) return;
    c.dataset.upgraded = "1";
    c.style.position = "relative";

    // Reply-to bar (above input)
    const replyBar = document.createElement("div");
    replyBar.className = "wa-reply-bar";
    replyBar.id = "wa-reply-bar";
    replyBar.innerHTML = `<span id="wa-reply-bar-text"></span><button id="wa-reply-cancel">✕</button>`;
    c.parentNode.insertBefore(replyBar, c);
    replyBar.querySelector("#wa-reply-cancel").onclick = () => { activeReplyTo = null; replyBar.classList.remove("open"); };

    // Attach button
    const attach = document.createElement("button");
    attach.className = "wa-attach-btn";
    attach.title = "Attach";
    attach.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16.5 6v11.5a4 4 0 1 1-8 0V5a2.5 2.5 0 1 1 5 0v10.5a1 1 0 1 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 1 0-8 0v12.5a5.5 5.5 0 1 0 11 0V6h-1.5z"/></svg>`;

    // Mic / voice-note button
    const mic = document.createElement("button");
    mic.className = "wa-mic-btn";
    mic.id = "wa-mic-btn";
    mic.title = "Hold to record voice";
    mic.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`;

    // Attach menu
    const menu = document.createElement("div");
    menu.className = "wa-attach-menu";
    menu.id = "wa-attach-menu";
    menu.innerHTML = `
      <button class="wa-attach-item" data-pick="image"><span class="ico">📷</span>Photo</button>
      <button class="wa-attach-item" data-pick="video"><span class="ico">🎥</span>Video</button>
      <button class="wa-attach-item" data-pick="audio"><span class="ico">🎵</span>Audio</button>
      <button class="wa-attach-item" data-pick="file"><span class="ico">📎</span>Document</button>
    `;
    c.appendChild(menu);

    // Hidden file inputs
    const inputs = {};
    [["image","image/*"],["video","video/*"],["audio","audio/*"],["file","*/*"]].forEach(([k,acc]) => {
      const i = document.createElement("input");
      i.type="file"; i.accept=acc; i.style.display="none";
      i.onchange = (e) => { const f=e.target.files?.[0]; if(f) sendMedia(f, k); i.value=""; };
      c.appendChild(i);
      inputs[k]=i;
    });

    // Insert buttons before the chat-input element (left side)
    const inputEl = document.getElementById("chat-input");
    c.insertBefore(attach, inputEl);
    c.appendChild(mic);

    attach.onclick = (e) => { e.stopPropagation(); menu.classList.toggle("open"); };
    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target) && e.target !== attach) menu.classList.remove("open");
    });
    menu.querySelectorAll(".wa-attach-item").forEach(b => {
      b.onclick = () => { menu.classList.remove("open"); inputs[b.dataset.pick].click(); };
    });

    // Voice note — press & hold
    let recorder, chunks = [], startedAt = 0;
    const pressStart = async (ev) => {
      ev.preventDefault();
      if (recorder) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
                  : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        chunks = [];
        startedAt = Date.now();
        recorder.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
        recorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const dur = Math.max(1, Math.round((Date.now() - startedAt)/1000));
          if (dur < 1) { recorder = null; return; }
          const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
          recorder = null;
          await sendVoiceNote(blob, dur);
        };
        recorder.start();
        mic.classList.add("recording");
      } catch (e) {
        alert("Microphone permission needed for voice notes");
      }
    };
    const pressEnd = () => {
      if (!recorder) return;
      mic.classList.remove("recording");
      try { recorder.stop(); } catch {}
    };
    mic.addEventListener("mousedown",  pressStart);
    mic.addEventListener("touchstart", pressStart, { passive: false });
    mic.addEventListener("mouseup",    pressEnd);
    mic.addEventListener("mouseleave", pressEnd);
    mic.addEventListener("touchend",   pressEnd);

    // Typing-indicator on text input
    const inp = document.getElementById("chat-input");
    inp.addEventListener("input", () => {
      if (!openChatId || !currentUid) return;
      const now = Date.now();
      if (now - lastTypingPing > 2000) {
        db.ref(`typing/${openChatId}/${currentUid}`).set(now);
        lastTypingPing = now;
      }
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        db.ref(`typing/${openChatId}/${currentUid}`).remove();
      }, 3000);
    });
  }

  /* ════════════════════════════════════════════════════════
     CHAT HEADER  — presence + typing
  ════════════════════════════════════════════════════════ */
  let presenceUnsub = null;
  let typingUnsub   = null;

  function upgradeChatHeaderUI() {
    const nameEl = document.getElementById("chat-contact-name");
    if (!nameEl || nameEl.dataset.upgraded) return;
    nameEl.dataset.upgraded = "1";
    const sub = document.createElement("div");
    sub.className = "wa-presence";
    sub.id = "wa-chat-presence";
    nameEl.parentNode.insertBefore(sub, nameEl.nextSibling);
  }

  function hookOpenChat() {
    // wrap the existing global openChatByUid + openChat path
    const origByUid = window.openChatByUid;
    window.openChatByUid = function(uid) {
      const ret = origByUid?.apply(this, arguments);
      // chat partner data is loaded async by the original; observe currentChatPartner
      const tryAttach = setInterval(() => {
        if (window.currentChatPartner) { clearInterval(tryAttach); attachToOpenChat(window.currentChatPartner); }
      }, 60);
      setTimeout(() => clearInterval(tryAttach), 4000);
      return ret;
    };

    // also intercept the existing chat-back to clear listeners
    const back = document.getElementById("chat-back-btn");
    if (back) back.addEventListener("click", detachFromChat, true);
  }

  function attachToOpenChat(partner) {
    if (!partner || !currentUid) return;
    detachFromChat();
    openChatPartner = partner;
    openChatId = [currentUid, partner.uid].sort().join("_");

    // Presence
    const presenceEl = document.getElementById("wa-chat-presence");
    presenceUnsub = watchPartnerPresence(partner.uid, (p) => {
      if (!presenceEl) return;
      presenceEl.textContent = p.state === "online" ? "online" : fmtLastSeen(p.lastSeen);
    });

    // Typing  (other user)
    const typingRef = db.ref(`typing/${openChatId}`);
    const typingCb = (snap) => {
      const v = snap.val() || {};
      const otherTyping = Object.entries(v).some(([u, ts]) => u !== currentUid && Date.now() - ts < 4000);
      let bar = document.getElementById("wa-typing-bar");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "wa-typing-bar";
        bar.className = "wa-typing";
        const cm = document.getElementById("chat-messages");
        cm.parentNode.insertBefore(bar, cm.nextSibling);
      }
      bar.textContent = otherTyping ? `${partner.name} is typing…` : "";
    };
    typingRef.on("value", typingCb);
    typingUnsub = () => typingRef.off("value", typingCb);

    // Re-render existing messages with media support — patch the message stream
    rebindMessageStream();

    // Mark all incoming as read
    markAllRead();
  }

  function detachFromChat() {
    presenceUnsub?.(); presenceUnsub = null;
    typingUnsub?.();   typingUnsub   = null;
    openChatPartner = null;
    openChatId = null;
    messageNodeMap.clear();
    if (currentUid && openChatId) db.ref(`typing/${openChatId}/${currentUid}`).remove();
  }

  /* ════════════════════════════════════════════════════════
     MESSAGE RENDERING  — overrides the simple text bubble
  ════════════════════════════════════════════════════════ */
  function rebindMessageStream() {
    if (!openChatId) return;
    const cm = document.getElementById("chat-messages");
    cm.innerHTML = "";
    messageNodeMap.clear();

    const ref = db.ref(`messages/${openChatId}`);
    ref.off();  // detach the original listener (it set bare text)

    ref.on("child_added", (snap) => renderMessage(snap.key, snap.val()));
    ref.on("child_changed", (snap) => renderMessage(snap.key, snap.val(), true));
    ref.on("child_removed", (snap) => {
      const n = messageNodeMap.get(snap.key);
      n?.remove();
      messageNodeMap.delete(snap.key);
    });
  }

  function renderMessage(id, msg, isUpdate) {
    if (!msg) return;
    const cm = document.getElementById("chat-messages");
    let div = messageNodeMap.get(id);
    const mine = msg.sender === currentUid;
    if (!div) {
      div = document.createElement("div");
      div.className = `message-bubble ${mine ? "message-sent" : "message-received"}`;
      div.dataset.msgId = id;
      messageNodeMap.set(id, div);
      cm.appendChild(div);
      attachMessageInteractions(div, id, msg);
    }
    div.innerHTML = "";

    // Reply quote
    if (msg.replyTo) {
      const rq = document.createElement("div");
      rq.className = "wa-reply-quote";
      rq.textContent = msg.replyTo.preview || "Reply";
      div.appendChild(rq);
    }

    // Body
    if (msg.media && msg.media.url) {
      div.classList.add("has-media");
      div.appendChild(renderMedia(msg.media));
      if (msg.text) {
        const cap = document.createElement("div");
        cap.style.padding = "4px 6px 0";
        cap.textContent = msg.text;
        div.appendChild(cap);
      }
    } else if (msg.text) {
      const t = document.createElement("div");
      t.textContent = msg.text;
      div.appendChild(t);
    }

    // Meta (time + ticks)
    const meta = document.createElement("div");
    meta.className = "wa-msg-meta";
    const time = document.createElement("span");
    time.textContent = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    meta.appendChild(time);
    if (mine) {
      const tick = document.createElement("span");
      tick.className = "wa-tick" + (msg.readAt ? " read" : "");
      tick.textContent = msg.readAt ? "✓✓" : (msg.deliveredAt ? "✓✓" : "✓");
      meta.appendChild(tick);
    }
    div.appendChild(meta);

    // Reactions
    const reactions = msg.reactions || {};
    const reactList = Object.values(reactions);
    if (reactList.length) {
      const r = document.createElement("div");
      r.className = "wa-reactions";
      const counts = {};
      reactList.forEach(e => { counts[e] = (counts[e]||0)+1; });
      r.textContent = Object.entries(counts).map(([e,c]) => c>1 ? `${e}${c}` : e).join(" ");
      div.appendChild(r);
    }

    // Mark read
    if (!mine && !msg.readAt) {
      db.ref(`messages/${openChatId}/${id}/readAt`).set(Date.now());
    }
    cm.scrollTop = cm.scrollHeight;
  }

  function renderMedia(m) {
    const wrap = document.createElement("div");
    if (m.type === "image") {
      const img = new Image();
      img.className = "wa-img";
      img.loading = "lazy";
      img.src = window.MediaUploader.optimized(m.url, 720);
      img.onclick = () => openMediaViewer({ type: "image", url: m.url });
      wrap.appendChild(img);
    } else if (m.type === "video") {
      const v = document.createElement("video");
      v.className = "wa-video";
      v.src = m.url;
      v.controls = true;
      v.preload = "metadata";
      v.poster = window.MediaUploader.videoPoster(m.url, 600);
      v.onclick = (e) => { e.preventDefault(); openMediaViewer({ type: "video", url: m.url }); };
      wrap.appendChild(v);
    } else if (m.type === "audio" || m.type === "voice") {
      const a = document.createElement("audio");
      a.className = "wa-audio";
      a.src = m.url;
      a.controls = true;
      a.preload = "metadata";
      wrap.appendChild(a);
      if (m.type === "voice" && m.duration) {
        const small = document.createElement("div");
        small.style.cssText = "font-size:11px;color:#667781;padding:2px 6px;";
        small.textContent = `🎙 Voice • ${m.duration}s`;
        wrap.appendChild(small);
      }
    } else {
      const a = document.createElement("a");
      a.className = "wa-file";
      a.href = m.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.download = m.name || "file";
      a.innerHTML = `<span class="ico">📄</span><div class="meta"><strong>${escapeHtml(m.name || "Document")}</strong><small>${humanBytes(m.bytes)} • Tap to open</small></div>`;
      wrap.appendChild(a);
    }
    return wrap;
  }

  function attachMessageInteractions(div, id, msg) {
    // dbl-click → react ❤️ ; long-press → reaction picker
    let pressT;
    const pickerOpen = (x, y) => openReactionPicker(id, x, y);
    div.addEventListener("dblclick", (e) => toggleReaction(id, "❤️"));
    div.addEventListener("touchstart", (e) => {
      pressT = setTimeout(() => pickerOpen(e.touches[0].clientX, e.touches[0].clientY - 40), 450);
    }, { passive: true });
    div.addEventListener("touchend", () => clearTimeout(pressT));
    div.addEventListener("touchmove", () => clearTimeout(pressT));
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      pickerOpen(e.clientX, e.clientY - 40);
    });
  }

  /* ════════════════════════════════════════════════════════
     SEND  — text override + media + voice
  ════════════════════════════════════════════════════════ */
  function hookSendButton() {
    const btn = document.getElementById("chat-send-btn");
    if (!btn) return;
    // Replace the original click listener by cloning the node
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener("click", sendText);
    // Enter to send
    document.getElementById("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
  }

  function getChatId() {
    return openChatId || (window.currentChatPartner && currentUid
      ? [currentUid, window.currentChatPartner.uid].sort().join("_") : null);
  }

  async function sendText() {
    const inp = document.getElementById("chat-input");
    const text = inp.value.trim();
    if (!text) return;
    const partner = window.currentChatPartner;
    if (!partner || !currentUid) return;
    const chatId = getChatId();
    const payload = {
      text,
      sender: currentUid,
      timestamp: Date.now(),
      deliveredAt: Date.now(),
    };
    if (activeReplyTo) {
      payload.replyTo = { id: activeReplyTo.id, preview: activeReplyTo.preview };
      activeReplyTo = null;
      document.getElementById("wa-reply-bar")?.classList.remove("open");
    }
    inp.value = "";
    await db.ref(`messages/${chatId}`).push(payload);
    db.ref(`typing/${chatId}/${currentUid}`).remove();
    pushNotify(partner, payload, text);
  }

  async function sendMedia(file, kind) {
    const partner = window.currentChatPartner;
    if (!partner || !currentUid) { alert("Open a chat first"); return; }
    const chatId = getChatId();

    // Optimistic uploading bubble
    const cm = document.getElementById("chat-messages");
    const tmp = document.createElement("div");
    tmp.className = "message-bubble message-sent has-media";
    tmp.innerHTML = `<div class="wa-uploading"><span>⬆ Uploading ${escapeHtml(file.name||kind)}…</span><div class="wa-progress"><i></i></div></div>`;
    cm.appendChild(tmp);
    cm.scrollTop = cm.scrollHeight;
    const bar = tmp.querySelector(".wa-progress > i");

    try {
      const up = await window.MediaUploader.upload(file, {
        chatId, kind,
        onProgress: (p) => { bar.style.width = p + "%"; },
      });
      tmp.remove();
      const media = {
        type:     kind,
        url:      up.url,
        publicId: up.publicId,
        bytes:    up.bytes,
        name:     up.originalName || file.name || kind,
        mime:     up.mime,
        width:    up.width,
        height:   up.height,
        duration: up.duration,
      };
      const payload = {
        sender: currentUid, timestamp: Date.now(), deliveredAt: Date.now(),
        media,
      };
      await db.ref(`messages/${chatId}`).push(payload);

      const previewText = kind === "image" ? "📷 Photo"
                        : kind === "video" ? "🎥 Video"
                        : kind === "audio" ? "🎵 Audio"
                        :                    "📎 " + (file.name || "Document");
      pushNotify(partner, payload, previewText);
    } catch (e) {
      tmp.innerHTML = `<div style="color:#c00;padding:6px;">Upload failed: ${escapeHtml(e.message)}</div>`;
      setTimeout(() => tmp.remove(), 4000);
    }
  }

  async function sendVoiceNote(blob, durationSec) {
    const partner = window.currentChatPartner;
    if (!partner || !currentUid) return;
    const chatId = getChatId();
    const cm = document.getElementById("chat-messages");
    const tmp = document.createElement("div");
    tmp.className = "message-bubble message-sent has-media";
    tmp.innerHTML = `<div class="wa-uploading"><span>🎙 Sending voice note…</span><div class="wa-progress"><i></i></div></div>`;
    cm.appendChild(tmp);
    const bar = tmp.querySelector(".wa-progress > i");
    try {
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type || "audio/webm" });
      const up = await window.MediaUploader.upload(file, {
        chatId, kind: "voice",
        onProgress: (p) => { bar.style.width = p + "%"; },
      });
      tmp.remove();
      const payload = {
        sender: currentUid, timestamp: Date.now(), deliveredAt: Date.now(),
        media: {
          type: "voice", url: up.url, publicId: up.publicId,
          bytes: up.bytes, duration: durationSec, mime: file.type,
        },
      };
      await db.ref(`messages/${chatId}`).push(payload);
      pushNotify(partner, payload, `🎙 Voice message (${durationSec}s)`);
    } catch (e) {
      tmp.innerHTML = `<div style="color:#c00;padding:6px;">Voice failed: ${escapeHtml(e.message)}</div>`;
      setTimeout(() => tmp.remove(), 4000);
    }
  }

  function pushNotify(partner, payload, previewText) {
    if (!window.sendPush || !partner) return;
    try {
      window.sendPush(partner.uid, window.currentUser?.profile?.name || "New message",
        previewText, { chatWith: currentUid, type: "message" });
    } catch {}
  }

  function markAllRead() {
    if (!openChatId || !currentUid) return;
    db.ref(`messages/${openChatId}`).orderByChild("readAt").equalTo(null).limitToLast(50).once("value", (snap) => {
      const updates = {};
      snap.forEach(s => {
        const v = s.val();
        if (v.sender !== currentUid && !v.readAt) updates[`messages/${openChatId}/${s.key}/readAt`] = Date.now();
      });
      if (Object.keys(updates).length) db.ref().update(updates);
    });
  }

  /* ════════════════════════════════════════════════════════
     REACTIONS + REPLY
  ════════════════════════════════════════════════════════ */
  function buildReactionPicker() {
    const p = document.createElement("div");
    p.className = "wa-react-picker";
    p.id = "wa-react-picker";
    ["❤️","😂","😮","😢","🙏","👍"].forEach(e => {
      const b = document.createElement("button");
      b.textContent = e;
      b.onclick = () => { toggleReaction(p.dataset.msgId, e); p.classList.remove("open"); };
      p.appendChild(b);
    });
    const reply = document.createElement("button");
    reply.textContent = "↩"; reply.title = "Reply";
    reply.onclick = () => { startReply(p.dataset.msgId); p.classList.remove("open"); };
    p.appendChild(reply);
    document.body.appendChild(p);
    document.addEventListener("click", (e) => { if (!p.contains(e.target)) p.classList.remove("open"); });
  }

  function openReactionPicker(msgId, x, y) {
    const p = document.getElementById("wa-react-picker");
    p.dataset.msgId = msgId;
    p.style.left = Math.min(window.innerWidth - 240, Math.max(10, x - 100)) + "px";
    p.style.top  = Math.max(60, y) + "px";
    p.classList.add("open");
  }

  async function toggleReaction(msgId, emoji) {
    if (!openChatId || !currentUid) return;
    const ref = db.ref(`messages/${openChatId}/${msgId}/reactions/${currentUid}`);
    const cur = (await ref.get()).val();
    if (cur === emoji) await ref.remove();
    else                await ref.set(emoji);
  }

  function startReply(msgId) {
    const node = messageNodeMap.get(msgId);
    if (!node) return;
    const preview = (node.textContent || "").trim().slice(0, 80);
    activeReplyTo = { id: msgId, preview };
    const bar = document.getElementById("wa-reply-bar");
    bar.querySelector("#wa-reply-bar-text").textContent = "Reply: " + preview;
    bar.classList.add("open");
    document.getElementById("chat-input").focus();
  }

  /* ════════════════════════════════════════════════════════
     PROFILE PHOTO
  ════════════════════════════════════════════════════════ */
  function hookProfilePhotoUpload() {
    // Add "Change profile photo" button to profile-view-modal
    const modal = document.getElementById("profile-view-modal");
    if (!modal || modal.dataset.upgraded) return;
    modal.dataset.upgraded = "1";
    const content = modal.querySelector(".modal-content");
    if (!content) return;
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;margin:8px 0 14px;";
    wrap.innerHTML = `
      <img id="wa-my-photo" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover;background:#eee;display:none;">
      <button id="wa-upload-photo" style="background:#25d366;color:#fff;border:0;padding:8px 14px;border-radius:18px;cursor:pointer;">Change Profile Photo</button>
      <input type="file" accept="image/*" id="wa-photo-input" style="display:none;">
    `;
    content.insertBefore(wrap, content.firstChild);

    const input  = wrap.querySelector("#wa-photo-input");
    const btn    = wrap.querySelector("#wa-upload-photo");
    const imgEl  = wrap.querySelector("#wa-my-photo");

    btn.onclick   = () => input.click();
    input.onchange = async () => {
      const f = input.files?.[0]; input.value="";
      if (!f) return;
      btn.disabled = true; btn.textContent = "Uploading…";
      try {
        const up = await window.MediaUploader.upload(f, { chatId: "_profile", kind: "image" });
        await db.ref(`users/${currentUid}/photoUrl`).set(up.url);
        imgEl.src = window.MediaUploader.thumb(up.url, 192);
        imgEl.style.display = "block";
        btn.textContent = "Change Profile Photo";
      } catch (e) {
        btn.textContent = "Failed — try again";
        console.error(e);
      } finally { btn.disabled = false; }
    };

    if (currentUid) {
      db.ref(`users/${currentUid}/photoUrl`).on("value", s => {
        const url = s.val();
        if (url) { imgEl.src = window.MediaUploader.thumb(url, 192); imgEl.style.display = "block"; }
      });
    }
  }

  /* ════════════════════════════════════════════════════════
     MEDIA VIEWER
  ════════════════════════════════════════════════════════ */
  function buildMediaViewer() {
    const v = document.createElement("div");
    v.className = "wa-mediaviewer";
    v.id = "wa-mediaviewer";
    v.innerHTML = `<button class="close" id="wa-mv-close">✕</button><div id="wa-mv-body"></div>`;
    document.body.appendChild(v);
    v.querySelector("#wa-mv-close").onclick = () => v.classList.remove("open");
    v.addEventListener("click", (e) => { if (e.target === v) v.classList.remove("open"); });
  }

  function openMediaViewer({ type, url }) {
    const v = document.getElementById("wa-mediaviewer");
    const body = v.querySelector("#wa-mv-body");
    body.innerHTML = "";
    if (type === "image") {
      const img = new Image(); img.src = url; body.appendChild(img);
    } else {
      const vid = document.createElement("video"); vid.src = url; vid.controls = true; vid.autoplay = true; body.appendChild(vid);
    }
    v.classList.add("open");
  }

  /* ════════════════════════════════════════════════════════
     UTILS
  ════════════════════════════════════════════════════════ */
  function escapeHtml(s){ return String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function humanBytes(b){ if(!b) return ""; const u=["B","KB","MB","GB"]; let i=0; while(b>=1024&&i<u.length-1){b/=1024;i++;} return b.toFixed(b<10?1:0)+" "+u[i]; }
})();

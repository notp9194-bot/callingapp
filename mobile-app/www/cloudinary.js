/* ============================================================
   CallingApp — Cloudinary client helper  v1.0
   ============================================================
   Exposes window.MediaUploader with:
     • upload(file, { chatId, kind, onProgress }) → { url, publicId, resourceType, bytes, width, height, duration }
     • uploadBlob(blob, name, opts)               → same as upload()
     • thumb(url, w=300)                          → on-the-fly thumbnail URL
     • destroy(publicId, resourceType)            → admin-only (uses SERVER_API_KEY if exposed)

   Requirements (set in index.html BEFORE this script):
     window.NOTIFICATION_SERVER_URL  = "https://your-server.onrender.com"
     window.firebase                 = (Firebase compat SDK already loaded)
============================================================ */
(function () {
  "use strict";

  const KIND_BY_MIME = (mime = "") => {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "file";
  };

  async function getIdToken() {
    const u = window.firebase?.auth?.().currentUser;
    if (!u) throw new Error("not_signed_in");
    return u.getIdToken();
  }

  async function fetchSignature({ chatId, kind }) {
    const base  = window.NOTIFICATION_SERVER_URL;
    if (!base) throw new Error("NOTIFICATION_SERVER_URL not set");
    const token = await getIdToken();
    const r = await fetch(`${base}/api/cloudinary/sign`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ chatId, kind }),
    });
    if (!r.ok) throw new Error(`sign_failed_${r.status}`);
    return r.json();
  }

  function postFormWithProgress(url, form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(new Error("bad_json_response")); }
        } else {
          reject(new Error(`upload_failed_${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
        }
      };
      xhr.onerror = () => reject(new Error("network_error"));
      xhr.send(form);
    });
  }

  async function upload(file, { chatId, kind, onProgress } = {}) {
    if (!file) throw new Error("no_file");
    const k = (kind || KIND_BY_MIME(file.type) || "file").toLowerCase();
    const sig = await fetchSignature({ chatId: chatId || "general", kind: k });

    if (file.size && sig.max_bytes && file.size > sig.max_bytes) {
      throw new Error(`file_too_large_${Math.round(sig.max_bytes / 1024 / 1024)}MB`);
    }

    const form = new FormData();
    form.append("file",      file);
    form.append("api_key",   sig.api_key);
    form.append("timestamp", sig.timestamp);
    form.append("signature", sig.signature);
    form.append("folder",    sig.folder);
    form.append("public_id", sig.public_id);
    form.append("tags",      sig.tags);
    form.append("type",      sig.type);

    const res = await postFormWithProgress(sig.upload_url, form, onProgress);

    return {
      url:          res.secure_url,
      publicId:     res.public_id,
      resourceType: res.resource_type,
      format:       res.format,
      bytes:        res.bytes,
      width:        res.width,
      height:       res.height,
      duration:     res.duration,
      originalName: file.name,
      mime:         file.type,
    };
  }

  function uploadBlob(blob, name = "blob", opts = {}) {
    const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
    return upload(file, opts);
  }

  /** Build a Cloudinary thumbnail URL from a delivered secure_url */
  function thumb(url, w = 300) {
    if (!url || typeof url !== "string") return url;
    return url.replace("/upload/", `/upload/c_fill,w_${w},h_${w},q_auto,f_auto/`);
  }

  /** Optimized media URL (auto format + quality, capped width) */
  function optimized(url, w = 1080) {
    if (!url || typeof url !== "string") return url;
    return url.replace("/upload/", `/upload/c_limit,w_${w},q_auto,f_auto/`);
  }

  /** Video poster (first frame as JPG) */
  function videoPoster(url, w = 600) {
    if (!url || typeof url !== "string") return url;
    return url
      .replace("/upload/", `/upload/so_0,c_fill,w_${w},h_${w},q_auto,f_jpg/`)
      .replace(/\.(mp4|mov|webm|mkv)(\?|$)/i, ".jpg$2");
  }

  window.MediaUploader = { upload, uploadBlob, thumb, optimized, videoPoster };
  console.log("[Cloudinary] MediaUploader ready");
})();

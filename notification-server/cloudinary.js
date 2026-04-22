/* ============================================================
   CallingApp — Cloudinary helper module  (signed uploads)
   ============================================================
   Exposes:
     • configure()                    — init from env
     • signUploadParams(opts)         — sign params for client-side direct upload
     • destroyAsset(publicId, type)   — delete a previously uploaded asset
     • isReady()                      — boolean
============================================================ */
"use strict";

const cloudinary = require("cloudinary").v2;

let READY = false;
let CFG = {};

function configure() {
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key    = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;

  if (!cloud_name || !api_key || !api_secret) {
    READY = false;
    return false;
  }

  cloudinary.config({ cloud_name, api_key, api_secret, secure: true });

  CFG = {
    cloud_name,
    api_key,
    folder: process.env.CLOUDINARY_UPLOAD_FOLDER || "callingapp",
    maxBytes: (parseInt(process.env.CLOUDINARY_MAX_FILE_MB || "50", 10)) * 1024 * 1024,
  };
  READY = true;
  return true;
}

function isReady() { return READY; }
function getConfig() { return { ...CFG }; }

/**
 * Sign upload params so a client can upload directly to Cloudinary.
 * The signature includes ONLY the parameters listed in `paramsToSign`.
 * The client MUST send exactly those params (and the file) in the upload.
 *
 * @param {object} opts
 * @param {string} opts.uid          — uploader uid (becomes part of public_id + tag)
 * @param {string} opts.chatId       — chat scope (used as a folder)
 * @param {string} opts.kind         — "image" | "video" | "audio" | "voice" | "file"
 * @returns {object} { cloud_name, api_key, timestamp, signature, folder, public_id, resource_type, tags, type, eager? }
 */
function signUploadParams({ uid, chatId, kind }) {
  if (!READY) throw new Error("cloudinary_not_configured");
  if (!uid)   throw new Error("uid required");

  const safeChat = String(chatId || "general").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 80);
  const folder   = `${CFG.folder}/${safeChat}`;
  const ts       = Math.floor(Date.now() / 1000);
  const rand     = Math.random().toString(36).slice(2, 10);

  // resource_type mapping
  let resource_type = "auto";
  if (kind === "image") resource_type = "image";
  else if (kind === "video" || kind === "voice" || kind === "audio") resource_type = "video"; // Cloudinary uses "video" for audio too
  else if (kind === "file" || kind === "doc") resource_type = "raw";

  const public_id = `${kind || "media"}_${uid}_${ts}_${rand}`;
  const tags      = [`uid_${uid}`, `chat_${safeChat}`, `kind_${kind || "media"}`].join(",");
  const type      = "upload"; // public

  // Params that will be signed (must be sent verbatim by the client)
  const paramsToSign = {
    folder,
    public_id,
    tags,
    timestamp: ts,
    type,
  };

  const signature = cloudinary.utils.api_sign_request(paramsToSign, CFG.api_secret);

  return {
    cloud_name:     CFG.cloud_name,
    api_key:        CFG.api_key,
    timestamp:      ts,
    signature,
    folder,
    public_id,
    tags,
    type,
    resource_type,
    max_bytes:      CFG.maxBytes,
    upload_url:     `https://api.cloudinary.com/v1_1/${CFG.cloud_name}/${resource_type}/upload`,
  };
}

async function destroyAsset(publicId, resourceType = "image") {
  if (!READY) throw new Error("cloudinary_not_configured");
  return cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true,
  });
}

module.exports = { configure, signUploadParams, destroyAsset, isReady, getConfig };

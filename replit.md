# CallingApp — Production WhatsApp Clone (Capacitor + Render + Cloudinary)

## Overview

CallingApp is an HTML/Capacitor messenger (Firebase Auth + Realtime DB + WebRTC) that has been upgraded to a production-grade WhatsApp clone with native FCM push, signed Cloudinary media uploads, and a rich messaging feature pack.

## Structure

```
mobile-app/                # Capacitor wrapper (Android/iOS)
  www/index.html           # Main UI
  www/fcm.js               # Native FCM (foreground + background)
  www/cloudinary.js        # MediaUploader (signed direct upload to Cloudinary)
  www/whatsapp-features.js # WhatsApp feature pack
  capacitor.config.json    # appId: com.callingapp.messenger
notification-server/       # Express + Firebase Admin + Cloudinary
  index.js                 # All routes (FCM + Cloudinary)
  cloudinary.js            # Signing / destroy helpers
  render.yaml              # Render Blueprint
.github/workflows/         # build-android.yml — auto APK build
README.md                  # Full setup guide
```

## How it works

- **Push**: foreground via Capacitor `pushNotificationReceived` + `LocalNotifications`; background via native FCM SDK tray.
- **Tokens**: stored in RTDB `fcmTokens/{uid}/{hash}` and on the Render server for fan-out.
- **Media**: client requests signed params from `/api/cloudinary/sign` (auth = Firebase ID token), then uploads directly to `https://api.cloudinary.com/v1_1/dvqqgqdls/<resource>/upload`. Server never streams the file → fast, cheap, scalable.
- **Presence**: RTDB `presence/{uid}` with `onDisconnect` for accurate online/last-seen.
- **Read receipts / typing / reactions / replies / profile photo**: handled in `whatsapp-features.js`.

## User actions required

1. Add Android app in Firebase Console (`com.callingapp.messenger`); download `google-services.json`.
2. Generate Firebase service-account JSON.
3. Set Render env vars:
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
   - `FIREBASE_DATABASE_URL`
   - `CLOUDINARY_CLOUD_NAME=dvqqgqdls`
   - `CLOUDINARY_API_KEY=344887545754427`
   - `CLOUDINARY_API_SECRET=krFxU3B6UmpRRigEm2EPNJxkdps`
4. Deploy `notification-server/` to Render via Blueprint.
5. Update `NOTIFICATION_SERVER_URL` in `mobile-app/www/index.html`.
6. Build APK locally (`npx cap add android` + Android Studio) or via GitHub Actions (set `GOOGLE_SERVICES_JSON` repo secret).

See `README.md` for the full step-by-step guide.

## Note

`mobile-app/` and `notification-server/` are standalone npm projects (not part of any pnpm workspace) so they ship cleanly when pushed to GitHub.

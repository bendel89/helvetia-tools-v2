const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");

admin.initializeApp();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// Date du jour en Suisse (AAAA-MM-JJ), décalée de "offset" jours.
function zurichDate(offset) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()).split("-").map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + offset));
  return d.toISOString().slice(0, 10);
}

function frDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// Rappels : 7 jours avant, la veille et le jour même.
const REMINDERS = [
  { offset: 7, label: (d) => `échéance dans 7 jours (${d})` },
  { offset: 1, label: (d) => `échéance demain (${d})` },
  { offset: 0, label: () => "échéance aujourd'hui" },
];

const APP_LINK = "https://bendel89.github.io/helvetia-tools-v2/";

exports.dailyReminders = functions.pubsub
  .schedule("every day 09:00")
  .timeZone("Europe/Zurich")
  .onRun(async () => {
    const db = admin.firestore();
    const messaging = admin.messaging();
    const targets = REMINDERS.map((r) => ({ ...r, date: zurichDate(r.offset) }));
    logger.info("Recherche des échéances", targets.map((t) => t.date));

    const usersSnap = await db.collection("users").get();
    let sent = 0;

    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      const token = userData.fcmToken;
      if (!token) continue;

      let appData;
      try {
        appData = JSON.parse(userData.data || "{}");
      } catch (e) {
        continue;
      }

      const allItems = [
        ...(appData.documents || []),
        ...(appData.family || []),
        ...(appData.applications || []),
      ];

      for (const t of targets) {
        const dueItems = allItems.filter((item) => item && !item.done && item.due === t.date);
        for (const item of dueItems) {
          try {
            await messaging.send({
              token,
              notification: {
                title: "📅 Rappel VigieSwiss",
                body: `${item.text} : ${t.label(frDate(t.date))}`,
              },
              webpush: { fcmOptions: { link: APP_LINK } },
            });
            sent++;
          } catch (e) {
            logger.warn("Erreur envoi :", e.message);
          }
        }
      }
    }

    logger.info("Total notifications envoyées :", sent);
    return null;
  });

// Bouton « Tester » de l'app : envoie une notification au compte connecté.
exports.sendTestPush = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Connectez-vous d'abord.");
  }
  const snap = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const token = snap.exists ? snap.data().fcmToken : null;
  if (!token) {
    throw new HttpsError("failed-precondition", "Activez d'abord les notifications sur cet appareil.");
  }
  try {
    await admin.messaging().send({
      token,
      notification: {
        title: "✅ Test VigieSwiss",
        body: "Les notifications fonctionnent. Vos rappels arriveront ici.",
      },
      webpush: { fcmOptions: { link: APP_LINK } },
    });
  } catch (e) {
    logger.warn("Test push échoué :", e.message);
    throw new HttpsError("unavailable", "L'envoi a échoué. Désactivez puis réactivez les notifications, puis réessayez.");
  }
  return { ok: true };
});

// Limites pour éviter qu'un inconnu utilise la clé API à tes frais.
const MAX_PROMPT_CHARS = 6000;
const MAX_IMAGE_BASE64_CHARS = 7000000; // environ 5 Mo d'image
const DAILY_LIMIT_PER_USER = 30;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

async function checkDailyQuota(key) {
  const db = admin.firestore();
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection("aiUsage").doc(`${key}_${day}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const count = (snap.exists ? snap.data().count : 0) + 1;
    if (count > DAILY_LIMIT_PER_USER) {
      throw new HttpsError(
        "resource-exhausted",
        "Limite quotidienne d'analyses atteinte. Réessaie demain."
      );
    }
    t.set(ref, { count, day }, { merge: true });
  });
}

exports.askClaude = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: "us-central1" },
  async (request) => {
    const data = request.data || {};
    const prompt = data.prompt;
    if (!prompt || typeof prompt !== "string") {
      throw new HttpsError("invalid-argument", "Prompt manquant.");
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new HttpsError("invalid-argument", "Texte trop long.");
    }

    // Quota par compte connecté, sinon par adresse IP.
    const caller =
      (request.auth && request.auth.uid) ||
      (request.rawRequest && request.rawRequest.ip) ||
      "inconnu";
    await checkDailyQuota(String(caller).replace(/[^a-zA-Z0-9_.:-]/g, "_"));

    // L'image était envoyée par l'app mais jamais transmise à Claude.
    let content = prompt;
    if (data.image) {
      const type = data.imageMimeType;
      if (!ALLOWED_IMAGE_TYPES.includes(type)) {
        throw new HttpsError("invalid-argument", "Format d'image non pris en charge.");
      }
      if (typeof data.image !== "string" || data.image.length > MAX_IMAGE_BASE64_CHARS) {
        throw new HttpsError("invalid-argument", "Image trop lourde.");
      }
      content = [
        { type: "image", source: { type: "base64", media_type: type, data: data.image } },
        { type: "text", text: prompt },
      ];
    }

    const apiKey = ANTHROPIC_API_KEY.value();

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error("Erreur Claude", response.status, errText);
      // Le détail reste dans les logs, pas chez l'utilisateur.
      throw new HttpsError("internal", "L'analyse est indisponible pour le moment.");
    }

    const result = await response.json();
    const textBlock = (result.content || []).find((b) => b.type === "text");
    return { text: textBlock ? textBlock.text : "" };
  }
);

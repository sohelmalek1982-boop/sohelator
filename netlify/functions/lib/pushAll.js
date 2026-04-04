const webpush = require("web-push");
const { getStore } = require("./blobsStore.cjs");

function configureVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:sohelator@localhost",
    pub,
    priv
  );
  return true;
}

async function sendPushToAll({ title, body, data = {} }) {
  if (!configureVapid()) return { skipped: true, reason: "VAPID keys not set" };
  const store = getStore('subscriptions');
  let sent = 0;
  let failed = 0;
  try {
    for await (const page of store.list({ prefix: "sub_", paginate: true })) {
      for (const entry of page.blobs || []) {
        try {
          const raw = await store.get(entry.key);
          if (!raw) continue;
          const sub = JSON.parse(raw);
          const payload = JSON.stringify({ title, body, ...data });
          await webpush.sendNotification(sub, payload);
          sent++;
        } catch {
          failed++;
        }
      }
    }
  } catch (e) {
    return { sent, failed, error: e.message };
  }
  return { sent, failed };
}

module.exports = { sendPushToAll };

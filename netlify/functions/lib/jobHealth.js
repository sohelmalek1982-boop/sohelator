const { getStore } = require("./blobsStore.cjs");

const KEY = "system_job_health";

function learningStore() {
  return getStore('learnings');
}

async function recordJobOk(jobId, meta = {}) {
  try {
    const s = learningStore();
    const cur = (await s.get(KEY, { type: "json" })) || {};
    cur[jobId] = {
      lastOk: Date.now(),
      ...meta,
    };
    await s.setJSON(KEY, cur);
  } catch (e) {
    console.error("recordJobOk", jobId, e);
  }
}

async function recordJobError(jobId, message) {
  try {
    const s = learningStore();
    const cur = (await s.get(KEY, { type: "json" })) || {};
    const prev = cur[jobId] || {};
    cur[jobId] = {
      ...prev,
      lastError: Date.now(),
      lastErrorMessage: String(message || "").slice(0, 500),
    };
    await s.setJSON(KEY, cur);
  } catch (e) {
    console.error("recordJobError", jobId, e);
  }
}

async function getJobHealth() {
  try {
    const s = learningStore();
    return (await s.get(KEY, { type: "json" })) || {};
  } catch {
    return {};
  }
}

module.exports = {
  recordJobOk,
  recordJobError,
  getJobHealth,
  KEY,
};

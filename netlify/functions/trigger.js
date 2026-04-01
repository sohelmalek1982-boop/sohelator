/**
 * SOHELATOR blueprint — cron-friendly entrypoint: runs the same path as scan (POST cheap).
 */

import { handler as scanHandler } from "./scan.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const mode =
    event.queryStringParameters?.mode === "expensive" ? "expensive" : "cheap";

  const synthetic = {
    httpMethod: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  };

  return scanHandler(synthetic);
};

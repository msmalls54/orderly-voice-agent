const apply = process.argv.includes("--apply");
const baseUrl = process.env.AGENTPHONE_API_BASE_URL ?? "https://api.agentphone.ai/v1";
const apiKey = process.env.AGENTPHONE_API_KEY;
const agentId = process.env.AGENTPHONE_AGENT_ID;
const destination = process.env.ADMIN_PHONE;
const allowed = new Set((process.env.ALLOWED_PHONES ?? "").split(",").map((value) => value.trim()).filter(Boolean));

if (!apply) throw new Error("Handset verification requires the explicit --apply flag");
if (!apiKey || !agentId || !destination || !/^\+[1-9]\d{7,14}$/.test(destination) || !allowed.has(destination)) {
  throw new Error("The allowlisted AgentPhone test destination is not configured");
}

let response;
try {
  response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      agent_id: agentId,
      to_number: destination,
      body: "Orderly connection test. Reply ORDERLY TEST. This message cannot create or purchase an order."
    }),
    signal: AbortSignal.timeout(15_000)
  });
} catch {
  console.error(JSON.stringify({ ok: false, outcome: "ambiguous", retrySafe: false }));
  process.exit(2);
}

const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(JSON.stringify({
    ok: false,
    outcome: response.status >= 500 || response.status === 408 ? "ambiguous" : "rejected",
    httpStatus: response.status,
    retrySafe: false
  }));
  process.exit(response.status >= 500 || response.status === 408 ? 2 : 1);
}

const receipt = payload?.data && typeof payload.data === "object" ? payload.data : payload;
console.log(JSON.stringify({
  ok: true,
  outcome: "accepted",
  receiptSuffix: typeof receipt?.id === "string" ? receipt.id.slice(-8) : null,
  status: typeof receipt?.status === "string" ? receipt.status : null,
  channel: typeof receipt?.channel === "string" ? receipt.channel : "sms"
}));

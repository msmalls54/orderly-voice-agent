const apply = process.argv.includes("--apply");
const baseUrl = process.env.AGENTPHONE_API_BASE_URL ?? "https://api.agentphone.ai/v1";
const apiKey = process.env.AGENTPHONE_API_KEY;
const agentId = process.env.AGENTPHONE_AGENT_ID;
const publicWebhookUrl = process.env.PUBLIC_WEBHOOK_URL;
const desired = {
  voiceMode: "webhook",
  voice: "11labs-Gilfoy",
  beginMessage: "Hello. This is Orderly. What would you like to order?",
  sttMode: "accurate",
  voiceSpeed: 1.25,
  interruptionSensitivity: 0.75
};

if (!apiKey || !agentId || !publicWebhookUrl) {
  throw new Error("AgentPhone inspection variables are incomplete");
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`AgentPhone ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}`);
  return response.json();
}

function record(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") return payload.data;
  return payload;
}

if (apply) {
  await request(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(desired)
  });
}

const agent = record(await request(`/agents/${encodeURIComponent(agentId)}`));
const webhook = record(await request(`/agents/${encodeURIComponent(agentId)}/webhook`));
const expectedWebhook = `${publicWebhookUrl.replace(/\/$/, "")}/sms`;
const result = {
  ok: agent?.voiceMode === desired.voiceMode
    && agent?.voice === desired.voice
    && agent?.beginMessage === desired.beginMessage
    && agent?.sttMode === desired.sttMode
    && agent?.voiceSpeed === desired.voiceSpeed
    && agent?.interruptionSensitivity === desired.interruptionSensitivity
    && webhook?.status === "active"
    && webhook?.url === expectedWebhook,
  applied: apply,
  agent: {
    voiceMode: agent?.voiceMode ?? null,
    voice: agent?.voice ?? null,
    hasBeginMessage: Boolean(agent?.beginMessage),
    sttMode: agent?.sttMode ?? null,
    voiceSpeed: agent?.voiceSpeed ?? null,
    interruptionSensitivity: agent?.interruptionSensitivity ?? null
  },
  webhook: {
    status: webhook?.status ?? null,
    urlMatchesExpected: webhook?.url === expectedWebhook,
    timeout: webhook?.timeout ?? null
  }
};

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;

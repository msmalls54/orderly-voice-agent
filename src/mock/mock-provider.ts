import type { OutboundMessage, ProviderReceipt, SmsProvider } from "../types.js";
import { SmsProviderError } from "../types.js";

export type MockSendScenario =
  | "success"
  | "api_rejection"
  | "timeout"
  | "rate_limit"
  | "ambiguous_provider_error";

export class MockSmsProvider implements SmsProvider {
  readonly name = "mock" as const;
  readonly calls: OutboundMessage[] = [];
  private sequence: MockSendScenario[];
  private receiptNumber = 0;

  constructor(sequence: MockSendScenario[] = ["success"]) {
    this.sequence = [...sequence];
  }

  push(...scenarios: MockSendScenario[]): void {
    this.sequence.push(...scenarios);
  }

  async send(message: OutboundMessage): Promise<ProviderReceipt> {
    this.calls.push({ ...message });
    const scenario = this.sequence.shift() ?? "success";
    switch (scenario) {
      case "success":
        this.receiptNumber += 1;
        return { providerMessageId: `msg_mock_${this.receiptNumber}`, providerStatus: "sent", channel: "sms" };
      case "api_rejection":
        throw new SmsProviderError("Mock API rejection", "VALIDATION_ERROR", false, false);
      case "timeout":
        throw new SmsProviderError("Mock timeout", "TRANSPORT_OUTCOME_UNKNOWN", false, true);
      case "rate_limit":
        throw new SmsProviderError("Mock rate limit", "RATE_LIMITED", true, false, 1);
      case "ambiguous_provider_error":
        throw new SmsProviderError("Mock provider error", "SMS_PROVIDER_ERROR", false, true);
    }
  }
}


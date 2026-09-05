import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppConfig } from "../config.js";

const execFile = promisify(execFileCallback);
const CartOrOrderId = z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/);
const ScheduledTime = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const CatalogId = z.string().min(1).max(40).regex(/^\d+$/);
const CatalogItemId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const CartItemInputSchema = z.object({
  itemId: CatalogItemId,
  itemName: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(20)
}).strict();

export type DoorDashCartItemInput = z.infer<typeof CartItemInputSchema>;

type Execute = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean }
) => Promise<{ stdout: string; stderr: string }>;

export class DoorDashCliError extends Error {
  constructor(readonly code: string, readonly ambiguous: boolean) {
    super(code);
    this.name = "DoorDashCliError";
  }
}

export class DoorDashCli {
  private readonly executable: string;

  constructor(private readonly config: AppConfig, private readonly execute: Execute = execFile) {
    this.executable = path.resolve(config.DOORDASH_CLI_PATH ?? ".runtime/dd-cli");
  }

  async version(): Promise<string> {
    const result = await this.runRaw(["--version"], false, false);
    const version = result.trim();
    if (!/^(?:[^,\s]+,\s+version\s+)?0\.2\.4$|^dd-cli\s+0\.2\.4$/i.test(version)) {
      throw new DoorDashCliError("DOORDASH_VERSION_MISMATCH", false);
    }
    return "0.2.4";
  }

  history(intent: string, max = 10, days = 30): Promise<unknown> {
    return this.runJson(["order", "history", "--max", String(max), "--days", String(days)], intent, false);
  }

  listCarts(storeId: string, intent: string): Promise<unknown> {
    return this.runJson(["cart", "list", "--store-id", CatalogId.parse(storeId)], intent, false);
  }

  showCart(cartUuid: string, intent: string): Promise<unknown> {
    return this.runJson(["cart", "show", "--cart-uuid", CartOrOrderId.parse(cartUuid)], intent, false);
  }

  addItems(storeId: string, menuId: string, items: readonly DoorDashCartItemInput[], intent: string): Promise<unknown> {
    const parsedItems = z.array(CartItemInputSchema).min(1).max(10).parse(items);
    const itemsJson = JSON.stringify(parsedItems.map((item) => ({
      item_id: item.itemId,
      item_name: item.itemName,
      quantity: item.quantity
    })));
    return this.runJson([
      "cart", "add-items",
      "--store-id", CatalogId.parse(storeId),
      "--menu-id", CatalogId.parse(menuId),
      "--items-json", itemsJson,
      "--fulfillment", "delivery"
    ], intent, true);
  }

  reorder(orderUuid: string, intent: string): Promise<unknown> {
    return this.runJson(["order", "reorder", "--order-uuid", CartOrOrderId.parse(orderUuid)], intent, true);
  }

  preview(cartUuid: string, intent: string, scheduledTime?: string): Promise<unknown> {
    const scheduleArgs = scheduledTime ? ["--scheduled-time", ScheduledTime.parse(scheduledTime)] : [];
    return this.runJson([
      "order", "preview", "--cart-uuid", CartOrOrderId.parse(cartUuid),
      "--include-work-benefits", ...scheduleArgs
    ], intent, false);
  }

  paymentMethods(intent: string): Promise<unknown> {
    return this.runJson(["payment-method", "list"], intent, false);
  }

  submit(cartUuid: string, tipCents: number, intent: string, scheduledTime?: string): Promise<unknown> {
    if (!this.config.PURCHASE_ENABLED) throw new DoorDashCliError("PURCHASE_DISABLED", false);
    const tip = z.number().int().min(0).max(20_000).parse(tipCents);
    const scheduleArgs = scheduledTime ? ["--scheduled-time", ScheduledTime.parse(scheduledTime)] : [];
    return this.runJson([
      "order", "submit", "--cart-uuid", CartOrOrderId.parse(cartUuid),
      "--tip-cents", String(tip), ...scheduleArgs, "--yes"
    ], intent, true);
  }

  status(orderUuid: string, intent: string): Promise<unknown> {
    return this.runJson(["order", "status", "--order-uuid", CartOrOrderId.parse(orderUuid)], intent, false);
  }

  private async runJson(args: string[], intent: string, mutation: boolean): Promise<unknown> {
    if (!this.config.DD_CLI_ACCESS_TOKEN) throw new DoorDashCliError("DOORDASH_NOT_CONNECTED", false);
    const boundedIntent = z.string().min(10).max(500).parse(intent);
    const output = await this.runRaw(["--json-output", ...args, "--intent", boundedIntent], mutation, true);
    try {
      return z.json().parse(JSON.parse(output));
    } catch {
      throw new DoorDashCliError("DOORDASH_JSON_SCHEMA_MISMATCH", mutation);
    }
  }

  private async runRaw(args: string[], mutation: boolean, requiresToken: boolean): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"],
      HOME: process.env["HOME"],
      TMPDIR: process.env["TMPDIR"],
      LANG: process.env["LANG"] ?? "C.UTF-8",
      LC_ALL: process.env["LC_ALL"] ?? "C.UTF-8"
    };
    if (requiresToken && this.config.DD_CLI_ACCESS_TOKEN) env["DD_CLI_ACCESS_TOKEN"] = this.config.DD_CLI_ACCESS_TOKEN;
    try {
      const result = await this.execute(this.executable, args, {
        env,
        timeout: mutation ? 35_000 : 20_000,
        maxBuffer: 1_048_576,
        windowsHide: true
      });
      return result.stdout;
    } catch {
      throw new DoorDashCliError(mutation ? "DOORDASH_MUTATION_OUTCOME_UNKNOWN" : "DOORDASH_COMMAND_FAILED", mutation);
    }
  }
}

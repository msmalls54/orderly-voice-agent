import express, { type Router } from "express";
import type { AppConfig } from "../config.js";
import { DoorDashCli } from "./cli.js";

export function createDoorDashHealthRouter(config: AppConfig, cli = new DoorDashCli(config)): Router {
  const router = express.Router();
  router.get("/health/doordash", async (_req, res) => {
    let binaryReady = false;
    try {
      binaryReady = await cli.version() === "0.2.4";
    } catch {
      binaryReady = false;
    }
    const tokenPresent = Boolean(config.DD_CLI_ACCESS_TOKEN);
    const accountVerified = config.DOORDASH_ACCOUNT_CONNECTED_VERIFIED;
    const ready = config.APP_MODE === "mock" || (binaryReady && tokenPresent && accountVerified);
    res.status(ready ? 200 : 503).json({
      ok: ready,
      mode: config.APP_MODE,
      binaryReady,
      pinnedVersion: "0.2.4",
      tokenPresent,
      accountVerified,
      purchaseEnabled: config.PURCHASE_ENABLED
    });
  });
  return router;
}

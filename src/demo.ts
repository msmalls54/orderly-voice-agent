import { applySafeDemoEnvironment } from "./demo-config.js";

applySafeDemoEnvironment();
await import("./index.js");

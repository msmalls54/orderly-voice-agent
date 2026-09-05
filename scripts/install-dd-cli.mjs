import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const version = "0.2.4";
const expectedSha256 = "37eec0c72bcb663aaf9759ea098d49d9c02266bb895cbbfbadeae41866608dd4";
const archiveName = `dd-cli-v${version}-linux-amd64.tar.gz`;
const url = `https://github.com/doordash-oss/doordash-cli/releases/download/v${version}/${archiveName}`;
const outputDirectory = path.resolve(".runtime");
const outputPath = path.join(outputDirectory, "dd-cli");

if (process.platform !== "linux" || process.arch !== "x64") {
  console.log(JSON.stringify({ installed: false, reason: "unsupported_build_host", required: "linux-x64" }));
  process.exit(0);
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orderly-dd-cli-"));
try {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download_failed_${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (actual !== expectedSha256) throw new Error("checksum_mismatch");
  const archivePath = path.join(temporaryDirectory, archiveName);
  fs.writeFileSync(archivePath, archive, { mode: 0o600 });
  execFileSync("tar", ["-xzf", archivePath, "-C", temporaryDirectory], { stdio: "ignore" });
  const extractedDirectory = path.join(
    temporaryDirectory,
    `dd-cli-v${version}-linux-amd64`
  );
  const extractedBinary = path.join(extractedDirectory, `dd-cli-v${version}-linux-amd64`);
  const extractedRuntime = path.join(extractedDirectory, "_internal");
  if (!fs.existsSync(extractedBinary) || !fs.existsSync(extractedRuntime)) {
    throw new Error("expected_runtime_bundle_missing");
  }
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.cpSync(extractedDirectory, outputDirectory, { recursive: true });
  fs.renameSync(path.join(outputDirectory, `dd-cli-v${version}-linux-amd64`), outputPath);
  fs.chmodSync(outputPath, 0o500);
  const versionOutput = execFileSync(outputPath, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (!versionOutput.includes(`version ${version}`)) throw new Error("installed_binary_version_mismatch");
  console.log(JSON.stringify({ installed: true, version, checksumVerified: true }));
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

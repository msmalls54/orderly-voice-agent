import crypto from "node:crypto";

const FORMAT = "v1";

export class CryptoBox {
  private readonly encryptionKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(encryptionKeyBase64: string, piiHashKey: string) {
    this.encryptionKey = Buffer.from(encryptionKeyBase64, "base64");
    if (this.encryptionKey.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must decode to 32 bytes");
    this.hashKey = Buffer.from(piiHashKey, "utf8");
    if (this.hashKey.length < 16) throw new Error("PII_HASH_KEY must be at least 16 bytes");
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [FORMAT, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
  }

  decrypt(value: string): string {
    const [format, ivText, tagText, ciphertextText] = value.split(":");
    if (format !== FORMAT || !ivText || !tagText || ciphertextText === undefined) throw new Error("Unsupported encrypted value");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  }

  fingerprint(value: string): string {
    return crypto.createHmac("sha256", this.hashKey).update(value).digest("hex");
  }
}


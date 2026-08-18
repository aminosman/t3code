import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import { signProviderToken } from "./ApnsClient.ts";

// APNs rejects a malformed provider token with a generic 403, so the signing
// details are worth pinning: they are otherwise only observable in production.
const keyPair = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const credentials = {
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: keyPair.privateKey,
  bundleId: "co.example.app",
};

const decodeSegment = (segment: string) =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;

describe("signProviderToken", () => {
  it("declares ES256 and the key id in the header", () => {
    const [header] = signProviderToken(credentials, 1_700_000_000_000).split(".");
    assert.deepEqual(decodeSegment(header!), {
      alg: "ES256",
      kid: "KEY1234567",
      typ: "JWT",
    });
  });

  it("issues for the team with a second-precision timestamp", () => {
    const [, payload] = signProviderToken(credentials, 1_700_000_000_123).split(".");
    assert.deepEqual(decodeSegment(payload!), {
      iss: "TEAM123456",
      // Apple expects seconds; milliseconds would read as the far future.
      iat: 1_700_000_000,
    });
  });

  it("produces a signature Apple can verify with the matching public key", () => {
    const token = signProviderToken(credentials, 1_700_000_000_000);
    const [header, payload, signature] = token.split(".");
    const verifier = NodeCrypto.createVerify("SHA256");
    verifier.update(`${header}.${payload}`);
    assert.isTrue(
      verifier.verify(
        { key: keyPair.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    );
  });

  it("uses the raw r||s encoding APNs requires, not DER", () => {
    const [, , signature] = signProviderToken(credentials, 1_700_000_000_000).split(".");
    // ieee-p1363 for P-256 is exactly 64 bytes; DER would be variable-length
    // and start with 0x30, which APNs rejects.
    assert.equal(Buffer.from(signature!, "base64url").length, 64);
  });
});

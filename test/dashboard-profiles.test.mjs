import test from "node:test";
import assert from "node:assert/strict";
import { discoverAwsProfiles, discoverOciProfiles, parseOciProfiles } from "../src/dashboard/profiles.mjs";

test("OCI profile parser returns unique sorted section names", () => {
  assert.deepEqual(parseOciProfiles("[PITWALL_API]\nkey_file=x\n[DEFAULT]\n[PITWALL_API]\n"), ["DEFAULT", "PITWALL_API"]);
});

test("profile discovery exposes names without credential values", async () => {
  const aws = await discoverAwsProfiles({ run: async () => ({ stdout: "dynamodb_poc\nsecondary\n" }) });
  const oci = await discoverOciProfiles({ file: "ignored", read: async () => "[DEFAULT]\nuser=secret-user\n[PITWALL_API]\nfingerprint=secret\n" });
  assert.deepEqual(aws.profiles, ["dynamodb_poc", "secondary"]);
  assert.deepEqual(oci.profiles, ["DEFAULT", "PITWALL_API"]);
  assert.equal(JSON.stringify({ aws, oci }).includes("secret-user"), false);
});

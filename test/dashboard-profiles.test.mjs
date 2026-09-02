import test from "node:test";
import assert from "node:assert/strict";
import { discoverAwsProfiles, discoverOciProfiles, parseOciProfiles, parseOciProfileValues } from "../src/dashboard/profiles.mjs";

test("OCI profile parser returns unique sorted section names", () => {
  assert.deepEqual(parseOciProfiles("[OCI_BENCHMARK]\nkey_file=x\n[DEFAULT]\n[OCI_BENCHMARK]\n"), ["DEFAULT", "OCI_BENCHMARK"]);
});

test("OCI profile values are scoped to the selected section", () => {
  const text = "[DEFAULT]\ntenancy=ocid.default\n[TEAM]\ntenancy = ocid.team\nregion=us-ashburn-1\n";
  assert.deepEqual(parseOciProfileValues(text, "TEAM"), { tenancy: "ocid.team", region: "us-ashburn-1" });
});

test("profile discovery exposes names without credential values", async () => {
  const aws = await discoverAwsProfiles({ run: async () => ({ stdout: "dynamodb_poc\nsecondary\n" }) });
  const oci = await discoverOciProfiles({ file: "ignored", read: async () => "[DEFAULT]\nuser=secret-user\n[OCI_BENCHMARK]\nfingerprint=secret\n" });
  assert.deepEqual(aws.profiles, ["dynamodb_poc", "secondary"]);
  assert.deepEqual(oci.profiles, ["DEFAULT", "OCI_BENCHMARK"]);
  assert.equal(JSON.stringify({ aws, oci }).includes("secret-user"), false);
});

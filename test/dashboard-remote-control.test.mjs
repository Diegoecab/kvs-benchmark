import assert from "node:assert/strict";
import test from "node:test";
import { discoverRegionalRunners } from "../src/dashboard/remote-control.mjs";

test("runner discovery returns only benchmark runners, OCI placement/IP, and evidence buckets", async () => {
  const executeCommand = async (file, args) => {
    if (file === "aws" && args[0] === "ec2") return JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-runner", State: { Name: "running" }, Placement: { AvailabilityZone: "us-east-1a" }, Tags: [{ Key: "Name", Value: "kvs-aws-runner" }] }, { InstanceId: "i-other", State: { Name: "running" }, Tags: [{ Key: "Name", Value: "application" }] }] }] });
    if (file === "aws" && args[0] === "ssm") return JSON.stringify({ InstanceInformationList: [{ InstanceId: "i-runner", PingStatus: "Online" }] });
    if (file === "aws" && args[0] === "s3api") return JSON.stringify({ Buckets: [{ Name: "kvs-benchmark-artifacts" }, { Name: "unrelated" }] });
    if (file === "oci" && args[0] === "search") return JSON.stringify({ data: { items: [{ identifier: "ocid1.instance.test", "display-name": "kvs-adb-runner", "lifecycle-state": "RUNNING", "availability-domain": "AD-1", "compartment-id": "ocid1.compartment.test" }] } });
    if (file === "oci" && args[0] === "compute") { assert.ok(args.includes("us-ashburn-1")); return JSON.stringify({ data: [{ "public-ip": "203.0.113.10" }] }); }
    throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
  };
  const result = await discoverRegionalRunners({ awsProfile: "aws", ociProfile: "oci", executeCommand });
  assert.deepEqual(result.aws.map(item => item.id), ["i-runner"]); assert.equal(result.aws[0].remoteControl, "SSM_ONLINE");
  assert.equal(result.oci[0].publicIp, "203.0.113.10"); assert.deepEqual(result.artifactBuckets, ["kvs-benchmark-artifacts"]);
});

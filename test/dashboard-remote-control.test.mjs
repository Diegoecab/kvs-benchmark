import assert from "node:assert/strict";
import test from "node:test";
import { discoverRegionalRunners } from "../src/dashboard/remote-control.mjs";

test("runner discovery returns only benchmark runners, provider-native control, and evidence buckets", async () => {
  const executeCommand = async (file, args) => {
    if (file === "aws" && args[0] === "ec2") return JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-runner", InstanceType: "t3.micro", State: { Name: "running" }, Placement: { AvailabilityZone: "us-east-1a" }, PrivateIpAddress: "10.0.1.10", PublicIpAddress: "203.0.113.10", PrivateDnsName: "ip-10-0-1-10.internal", Tags: [{ Key: "Name", Value: "kvs-aws-runner" }] }, { InstanceId: "i-other", State: { Name: "running" }, Tags: [{ Key: "Name", Value: "application" }] }] }] });
    if (file === "aws" && args[0] === "ssm") return JSON.stringify({ InstanceInformationList: [{ InstanceId: "i-runner", PingStatus: "Online", IPAddress: "10.0.1.10" }] });
    if (file === "aws" && args[0] === "s3api") return JSON.stringify({ Buckets: [{ Name: "kvs-benchmark-artifacts" }, { Name: "unrelated" }] });
    if (file === "oci" && args[0] === "search") return JSON.stringify({ data: { items: [{ identifier: "ocid1.instance.test", "display-name": "kvs-adb-runner", "lifecycle-state": "RUNNING", "availability-domain": "AD-1", "compartment-id": "ocid1.compartment.test" }] } });
    if (file === "oci" && args[0] === "instance-agent") return JSON.stringify({ data: [{ name: "Compute Instance Run Command", status: "RUNNING" }] });
    if (file === "oci" && args[0] === "compute") return JSON.stringify({ data: [{ id: "ocid1.vnic.test", "is-primary": true, "private-ip": "10.0.2.10", "public-ip": "198.51.100.10", "hostname-label": "kvs-adb-runner", "subnet-id": "ocid1.subnet.test" }] });
    throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
  };
  const result = await discoverRegionalRunners({ awsProfile: "aws", ociProfile: "oci", executeCommand });
  assert.deepEqual(result.aws.map(item => item.id), ["i-runner"]); assert.equal(result.aws[0].remoteControl, "SSM_ONLINE");
  assert.equal(result.aws[0].displayName, "kvs-aws-runner"); assert.equal(result.aws[0].availabilityZone, "us-east-1a"); assert.equal(result.aws[0].shape, "t3.micro"); assert.equal(result.aws[0].privateIp, "10.0.1.10"); assert.equal(result.aws[0].publicIp, "203.0.113.10");
  assert.deepEqual(result.aws[0].networkIdentity, { source: "AWS_EC2_METADATA", privateIp: "10.0.1.10", publicIp: "203.0.113.10", hostname: "ip-10-0-1-10.internal", egressIpVerified: false });
  assert.equal(result.oci[0].remoteControl, "RUN_COMMAND_RUNNING"); assert.equal(result.oci[0].displayName, "kvs-adb-runner"); assert.equal(result.oci[0].availabilityDomain, "AD-1"); assert.equal(result.oci[0].privateIp, "10.0.2.10"); assert.equal(result.oci[0].publicIp, "198.51.100.10");
  assert.deepEqual(result.oci[0].networkIdentity, { source: "OCI_VNIC_METADATA", privateIp: "10.0.2.10", publicIp: "198.51.100.10", hostname: "kvs-adb-runner", vnicId: "ocid1.vnic.test", subnetId: "ocid1.subnet.test", egressIpVerified: false });
  assert.deepEqual(result.artifactBuckets, ["kvs-benchmark-artifacts"]);
});

test("runner discovery keeps OCI runners when VNIC metadata is not accessible", async () => {
  const executeCommand = async (file, args) => {
    if (file === "oci" && args[0] === "search") return JSON.stringify({ data: { items: [{ identifier: "ocid1.instance.restricted", "display-name": "benchmark-runner", "lifecycle-state": "RUNNING", "availability-domain": "AD-2", "compartment-id": "ocid1.compartment.test" }] } });
    if (file === "oci" && args[0] === "instance-agent") return JSON.stringify({ data: [{ status: "RUNNING" }] });
    if (file === "oci" && args[0] === "compute") throw new Error("NotAuthorizedOrNotFound");
    throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
  };
  const result = await discoverRegionalRunners({ ociProfile: "oci", clouds: { aws: false, oci: true }, executeCommand });
  assert.equal(result.oci.length, 1); assert.equal(result.oci[0].remoteControl, "RUN_COMMAND_RUNNING"); assert.equal(result.oci[0].privateIp, null); assert.equal(result.oci[0].publicIp, null);
  assert.deepEqual(result.oci[0].networkIdentity, { source: "OCI_VNIC_METADATA", privateIp: null, publicIp: null, hostname: null, egressIpVerified: false });
});

test("runner discovery never contacts an unselected cloud", async () => {
  const awsCalls = [];
  const aws = await discoverRegionalRunners({ awsProfile: "aws", clouds: { aws: true, oci: false }, executeCommand: async (file, args) => { assert.equal(file, "aws"); awsCalls.push(args[0]); if (args[0] === "ec2") return '{"Reservations":[]}'; if (args[0] === "ssm") return '{"InstanceInformationList":[]}'; return '{"Buckets":[]}'; } });
  assert.deepEqual(aws.oci, []); assert.deepEqual(awsCalls.sort(), ["ec2", "s3api", "ssm"]);
  const ociCalls = [];
  const oci = await discoverRegionalRunners({ ociProfile: "oci", clouds: { aws: false, oci: true }, executeCommand: async (file, args) => { assert.equal(file, "oci"); ociCalls.push(args[0]); return '{"data":{"items":[]}}'; } });
  assert.deepEqual(oci.aws, []); assert.deepEqual(oci.artifactBuckets, []); assert.deepEqual(ociCalls, ["search"]);
});

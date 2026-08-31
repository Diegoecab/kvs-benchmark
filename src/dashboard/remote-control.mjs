import { execFile } from "node:child_process";

function execute(file, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`${file} failed: ${(stderr || error.message).trim()}`));
    resolve(stdout);
  }));
}

const parse = value => JSON.parse(value || "{}");

export async function discoverRegionalRunners({ awsProfile, awsRegion = "us-east-1", ociProfile, ociRegion = "us-ashburn-1", executeCommand = execute }) {
  if (!/^[A-Za-z0-9_.-]+$/.test(awsProfile || "")) throw new Error("A valid AWS profile is required");
  if (!/^[A-Za-z0-9_.-]+$/.test(ociProfile || "")) throw new Error("A valid OCI profile is required");
  const [ec2Raw, ssmRaw, bucketsRaw, ociRaw] = await Promise.all([
    executeCommand("aws", ["ec2", "describe-instances", "--profile", awsProfile, "--region", awsRegion, "--filters", "Name=instance-state-name,Values=running", "--output", "json"]),
    executeCommand("aws", ["ssm", "describe-instance-information", "--profile", awsProfile, "--region", awsRegion, "--output", "json"]),
    executeCommand("aws", ["s3api", "list-buckets", "--profile", awsProfile, "--output", "json"]),
    executeCommand("oci", ["search", "resource", "structured-search", "--profile", ociProfile, "--query-text", "query instance resources where lifecycleState = 'RUNNING'", "--output", "json"]),
  ]);
  const ssm = new Map((parse(ssmRaw).InstanceInformationList || []).map(item => [item.InstanceId, item]));
  const aws = (parse(ec2Raw).Reservations || []).flatMap(item => item.Instances || []).map(instance => ({ provider: "aws", id: instance.InstanceId, name: (instance.Tags || []).find(tag => tag.Key === "Name")?.Value || instance.InstanceId, state: instance.State?.Name, placement: instance.Placement?.AvailabilityZone, remoteControl: ssm.get(instance.InstanceId)?.PingStatus === "Online" ? "SSM_ONLINE" : "SSM_OFFLINE" })).filter(item => /benchmark|runner|kvs/i.test(item.name));
  const ociItems = (parse(ociRaw).data?.items || []).filter(item => /runner/i.test(item["display-name"] || ""));
  const oci = await Promise.all(ociItems.map(async item => {
    let publicIp = null;
    try {
      const vnics = parse(await executeCommand("oci", ["compute", "instance", "list-vnics", "--profile", ociProfile, "--region", ociRegion, "--instance-id", item.identifier, "--output", "json"]));
      publicIp = vnics.data?.find(vnic => vnic["public-ip"])?.["public-ip"] || null;
    } catch {}
    return { provider: "oci", id: item.identifier, name: item["display-name"], state: item["lifecycle-state"], placement: item["availability-domain"], compartmentId: item["compartment-id"], publicIp, remoteControl: publicIp ? "SSH_READY" : "RUN_COMMAND_ONLY" };
  }));
  const artifactBuckets = (parse(bucketsRaw).Buckets || []).map(item => item.Name).filter(name => /benchmark|artifact|evidence|kvs/i.test(name));
  return { schemaVersion: 1, discoveredAt: new Date().toISOString(), aws, oci, artifactBuckets };
}

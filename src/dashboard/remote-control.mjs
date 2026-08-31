import { execFile } from "node:child_process";

function execute(file, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`${file} failed: ${(stderr || error.message).trim()}`));
    resolve(stdout);
  }));
}

const parse = value => JSON.parse(value || "{}");

export async function discoverRegionalRunners({ awsProfile, awsRegion = "us-east-1", ociProfile, ociRegion = "us-ashburn-1", clouds = { aws: true, oci: true }, executeCommand = execute }) {
  if (clouds.aws !== false && !/^[A-Za-z0-9_.-]+$/.test(awsProfile || "")) throw new Error("A valid AWS profile is required");
  if (clouds.oci !== false && !/^[A-Za-z0-9_.-]+$/.test(ociProfile || "")) throw new Error("A valid OCI profile is required");
  const [ec2Raw, ssmRaw, bucketsRaw, ociRaw] = await Promise.all([
    clouds.aws === false ? Promise.resolve('{"Reservations":[]}') : executeCommand("aws", ["ec2", "describe-instances", "--profile", awsProfile, "--region", awsRegion, "--filters", "Name=instance-state-name,Values=running", "--output", "json"]),
    clouds.aws === false ? Promise.resolve('{"InstanceInformationList":[]}') : executeCommand("aws", ["ssm", "describe-instance-information", "--profile", awsProfile, "--region", awsRegion, "--output", "json"]),
    clouds.aws === false ? Promise.resolve('{"Buckets":[]}') : executeCommand("aws", ["s3api", "list-buckets", "--profile", awsProfile, "--output", "json"]),
    clouds.oci === false ? Promise.resolve('{"data":{"items":[]}}') : executeCommand("oci", ["search", "resource", "structured-search", "--profile", ociProfile, "--query-text", "query instance resources where lifecycleState = 'RUNNING'", "--output", "json"]),
  ]);
  const ssm = new Map((parse(ssmRaw).InstanceInformationList || []).map(item => [item.InstanceId, item]));
  const aws = (parse(ec2Raw).Reservations || []).flatMap(item => item.Instances || []).map(instance => ({ provider: "aws", id: instance.InstanceId, name: (instance.Tags || []).find(tag => tag.Key === "Name")?.Value || instance.InstanceId, state: instance.State?.Name, placement: instance.Placement?.AvailabilityZone, remoteControl: ssm.get(instance.InstanceId)?.PingStatus === "Online" ? "SSM_ONLINE" : "SSM_OFFLINE" })).filter(item => /benchmark|runner|kvs/i.test(item.name));
  const ociItems = (parse(ociRaw).data?.items || []).filter(item => /runner/i.test(item["display-name"] || ""));
  const oci = await Promise.all(ociItems.map(async item => {
    let status = "UNKNOWN";
    try {
      const plugins = parse(await executeCommand("oci", ["instance-agent", "plugin", "list", "--profile", ociProfile, "--region", ociRegion, "--compartment-id", item["compartment-id"], "--instanceagent-id", item.identifier, "--name", "Compute Instance Run Command", "--output", "json"]));
      status = plugins.data?.[0]?.status || "NOT_REPORTED";
    } catch {}
    return { provider: "oci", id: item.identifier, name: item["display-name"], state: item["lifecycle-state"], placement: item["availability-domain"], compartmentId: item["compartment-id"], remoteControl: `RUN_COMMAND_${status}` };
  }));
  const artifactBuckets = (parse(bucketsRaw).Buckets || []).map(item => item.Name).filter(name => /benchmark|artifact|evidence|kvs/i.test(name));
  return { schemaVersion: 1, discoveredAt: new Date().toISOString(), aws, oci, artifactBuckets };
}

import { execFile } from "node:child_process";

function execute(file, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`${file} failed: ${(stderr || error.message).trim()}`));
    resolve(stdout);
  }));
}

const parse = value => JSON.parse(value || "{}");

function networkIdentity({ privateIp, publicIp, hostname, vnicId, subnetId, source }) {
  return {
    source,
    privateIp: privateIp || null,
    publicIp: publicIp || null,
    hostname: hostname || null,
    ...(vnicId ? { vnicId } : {}),
    ...(subnetId ? { subnetId } : {}),
    // Provider metadata identifies the VM/VNIC, but cannot prove the address
    // observed by a remote service after routing, NAT, or proxying.
    egressIpVerified: false,
  };
}

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
  const aws = (parse(ec2Raw).Reservations || []).flatMap(item => item.Instances || []).map(instance => {
    const manager = ssm.get(instance.InstanceId), displayName = (instance.Tags || []).find(tag => tag.Key === "Name")?.Value || instance.InstanceId;
    const privateIp = instance.PrivateIpAddress || manager?.IPAddress || null, publicIp = instance.PublicIpAddress || null;
    const hostname = instance.PrivateDnsName || manager?.ComputerName || null, availabilityZone = instance.Placement?.AvailabilityZone || null;
    return {
      provider: "aws", id: instance.InstanceId, name: displayName, displayName, state: instance.State?.Name, placement: availabilityZone, availabilityZone, shape: instance.InstanceType,
      privateIp, publicIp, hostname,
      networkIdentity: networkIdentity({ privateIp, publicIp, hostname, source: "AWS_EC2_METADATA" }),
      remoteControl: manager?.PingStatus === "Online" ? "SSM_ONLINE" : "SSM_OFFLINE",
    };
  }).filter(item => /benchmark|runner|kvs/i.test(item.name));
  const ociItems = (parse(ociRaw).data?.items || []).filter(item => /runner/i.test(item["display-name"] || ""));
  const oci = await Promise.all(ociItems.map(async item => {
    let status = "UNKNOWN";
    let primaryVnic = null;
    const [pluginResult, vnicResult] = await Promise.allSettled([
      executeCommand("oci", ["instance-agent", "plugin", "list", "--profile", ociProfile, "--region", ociRegion, "--compartment-id", item["compartment-id"], "--instanceagent-id", item.identifier, "--name", "Compute Instance Run Command", "--output", "json"]),
      executeCommand("oci", ["compute", "instance", "list-vnics", "--profile", ociProfile, "--region", ociRegion, "--instance-id", item.identifier, "--output", "json"]),
    ]);
    if (pluginResult.status === "fulfilled") status = parse(pluginResult.value).data?.[0]?.status || "NOT_REPORTED";
    if (vnicResult.status === "fulfilled") {
      const vnics = parse(vnicResult.value).data || [];
      primaryVnic = vnics.find(vnic => vnic["is-primary"]) || vnics[0] || null;
    }
    const displayName = item["display-name"], privateIp = primaryVnic?.["private-ip"] || null, publicIp = primaryVnic?.["public-ip"] || null;
    const hostname = primaryVnic?.["hostname-label"] || null, availabilityDomain = item["availability-domain"] || primaryVnic?.["availability-domain"] || null;
    return {
      provider: "oci", id: item.identifier, name: displayName, displayName, state: item["lifecycle-state"], placement: availabilityDomain, availabilityDomain, shape: item.shape || null,
      compartmentId: item["compartment-id"], privateIp, publicIp, hostname,
      networkIdentity: networkIdentity({ privateIp, publicIp, hostname, vnicId: primaryVnic?.id, subnetId: primaryVnic?.["subnet-id"], source: "OCI_VNIC_METADATA" }),
      remoteControl: `RUN_COMMAND_${status}`,
    };
  }));
  const artifactBuckets = (parse(bucketsRaw).Buckets || []).map(item => item.Name).filter(name => /benchmark|artifact|evidence|kvs/i.test(name));
  return { schemaVersion: 1, discoveredAt: new Date().toISOString(), aws, oci, artifactBuckets };
}

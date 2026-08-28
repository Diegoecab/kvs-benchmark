import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export function awsMetricQueries(table, period = 60) {
  const metric = (id, metricName, stat, operation) => ({ Id: id, MetricStat: { Metric: { Namespace: "AWS/DynamoDB", MetricName: metricName, Dimensions: [{ Name: "TableName", Value: table }, ...(operation ? [{ Name: "Operation", Value: operation }] : [])] }, Period: period, Stat: stat }, ReturnData: true });
  return [
    metric("consumed_read", "ConsumedReadCapacityUnits", "Sum"), metric("consumed_write", "ConsumedWriteCapacityUnits", "Sum"),
    metric("provisioned_read", "ProvisionedReadCapacityUnits", "Average"), metric("provisioned_write", "ProvisionedWriteCapacityUnits", "Average"),
    metric("read_throttle", "ReadThrottleEvents", "Sum"), metric("write_throttle", "WriteThrottleEvents", "Sum"),
    metric("get_latency", "SuccessfulRequestLatency", "Average", "GetItem"), metric("get_system_errors", "SystemErrors", "Sum", "GetItem"), metric("get_user_errors", "UserErrors", "Sum", "GetItem"), metric("get_throttled", "ThrottledRequests", "Sum", "GetItem"),
  ];
}

export function ociMetricQueries(target, resourceId) {
  const definitions = target === "ndcs"
    ? [["ReadUnits", "sum"], ["WriteUnits", "sum"], ["ReadThrottleCount", "sum"], ["WriteThrottleCount", "sum"], ["StorageThrottleCount", "sum"], ["StorageGB", "mean"], ["MaxShardSizeUsagePercent", "max"]]
    : [["GetItem", "sum"], ["SuccessfulRequestLatency", "mean"], ["RequestCount", "sum"], ["UserErrors", "sum"], ["ECPUsAllocated", "mean"], ["CpuUtilization", "mean"], ["DatabaseAvailability", "mean"], ["CurrentLogons", "max"]];
  return definitions.map(([name, statistic]) => ({ name, query: `${name}[1m]{resourceId = "${resourceId}"}.${statistic}()` }));
}

function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

async function command(file, args) {
  const { stdout } = await runFile(file, args, { windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : { data: [] };
}

export async function collectMetrics({ target, table, startAt, endAt, output, region, compartment, resourceId, profile }) {
  const start = new Date(startAt), end = new Date(endAt); if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("valid startAt/endAt are required");
  fs.mkdirSync(output, { recursive: true }); let report;
  if (target === "aws") {
    if (!table) throw new Error("table is required for AWS metrics");
    const queries = awsMetricQueries(table); const response = await command("aws", ["cloudwatch", "get-metric-data", "--region", region || process.env.AWS_REGION || "us-east-1", "--start-time", start.toISOString(), "--end-time", end.toISOString(), "--scan-by", "TimestampAscending", "--metric-data-queries", JSON.stringify(queries), "--output", "json"]);
    report = { schemaVersion: 1, target, startAt: start.toISOString(), endAt: end.toISOString(), periodSeconds: 60, metrics: response.MetricDataResults || [], messages: response.Messages || [] };
  } else if (["adb", "ndcs"].includes(target)) {
    compartment ||= requiredEnv("OCI_COMPARTMENT_ID"); resourceId ||= requiredEnv("OCI_RESOURCE_ID"); profile ||= process.env.OCI_PROFILE || "DEFAULT";
    const namespace = target === "ndcs" ? "oci_nosql" : "oci_autonomous_database";
    if (!/^ocid1\.[a-z0-9.-]+$/i.test(compartment) || !/^ocid1\.[a-z0-9.-]+$/i.test(resourceId)) throw new Error("OCI compartment/resource identifiers are malformed");
    const metrics = await Promise.all(ociMetricQueries(target, resourceId).map(async definition => {
      const response = await command("oci", ["--profile", profile, "monitoring", "metric-data", "summarize-metrics-data", "--compartment-id", compartment, "--namespace", namespace, "--query-text", definition.query, "--start-time", start.toISOString(), "--end-time", end.toISOString(), "--output", "json"]);
      return { name: definition.name, series: response.data || [] };
    }));
    report = { schemaVersion: 1, target, namespace, startAt: start.toISOString(), endAt: end.toISOString(), periodSeconds: 60, metrics };
  } else throw new Error("metrics target must be aws, adb, or ndcs");
  report.generatedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, "provider-metrics.json"), `${JSON.stringify(report, null, 2)}\n`); return report;
}

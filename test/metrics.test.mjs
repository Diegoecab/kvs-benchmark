import test from "node:test";
import assert from "node:assert/strict";
import { awsMetricQueries, ociMetricQueries } from "../src/collectors/metrics.mjs";

test("AWS metrics include capacity, latency, errors, and throttling", () => {
  const queries = awsMetricQueries("fixture"); const names = queries.map(value => value.MetricStat.Metric.MetricName);
  for (const name of ["ConsumedReadCapacityUnits", "ProvisionedReadCapacityUnits", "SuccessfulRequestLatency", "SystemErrors", "UserErrors", "ThrottledRequests"]) assert.ok(names.includes(name));
  assert.ok(queries.every(value => value.MetricStat.Metric.Dimensions.some(dimension => dimension.Name === "TableName" && dimension.Value === "fixture")));
});

test("OCI collectors include NoSQL throttles and ADB DynamoDB API metrics", () => {
  assert.ok(ociMetricQueries("ndcs", "resource").some(value => value.name === "ReadThrottleCount"));
  assert.ok(ociMetricQueries("adb", "resource").some(value => value.name === "GetItem"));
  assert.ok(ociMetricQueries("adb", "resource").some(value => value.name === "SuccessfulRequestLatency"));
});

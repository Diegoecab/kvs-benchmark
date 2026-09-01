# Cloud execution prerequisites

This document defines the prerequisites for running the benchmark suite against existing infrastructure. The benchmark repository does not provision databases, tables, networks, IAM, or runners.

## Identity model

Cloud execution uses two independent identities:

1. The **operator identity** is the AWS/OCI profile selected in the local dashboard. It discovers resources, submits remote commands, monitors them, and downloads evidence.
2. The **runner identity** is the EC2 instance role or OCI instance principal. It receives the command, accesses only its benchmark table, and uploads evidence.

An administrator user does not automatically grant permissions to an OCI compute instance. OCI Run Command therefore requires both an operator policy and a dynamic-group policy for the runner. See Oracle's [Run Command policy requirements](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/instances.htm#run-command) and [Run Command troubleshooting](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/runningcommands.htm).

## Local control plane

- Node.js 22 and the repository dependencies installed with `npm ci`.
- AWS CLI v2 and OCI CLI in `PATH`.
- Configured AWS and OCI profiles; credentials never enter the browser or run specification.
- Outbound HTTPS access to the selected cloud APIs.
- Access to `http://127.0.0.1:4177`; the dashboard binds only to loopback.

The operator profiles require these capabilities:

| Provider | Required control-plane capabilities |
|---|---|
| AWS | Discover EC2 runners and SSM status; list/describe DynamoDB tables and Application Auto Scaling targets; invoke and inspect `AWS-RunShellScript`; list the evidence bucket and download its objects. |
| OCI | Inspect compartments and running instances; read Oracle Cloud Agent plugin state; create/list/read `instance-agent-command-family`; inspect ADB and OCI NoSQL resources; inspect evidence buckets and list/read their objects. |

For OCI Run Command, the operator group needs the following baseline statement in the runner compartment:

```text
Allow group <OPERATOR_GROUP> to manage instance-agent-command-family in compartment id <RUNNER_COMPARTMENT_OCID>
```

## Runner baseline

Every runner must:

- be a dedicated Linux `linux/amd64` VM in the same benchmark region as its database;
- have sufficient CPU, memory, and network capacity to avoid becoming the bottleneck;
- run Podman or Docker and contain the exact immutable image digest selected in the dashboard;
- have `chronyc`, `jq`, and a synchronized clock;
- have no autoscaling or background workload that changes the client capacity during a session;
- have outbound HTTPS access to its database endpoint, evidence store, IAM/control service, and container registry when an image pull is required.

No public IP, SSH, SCP, private SSH key, or inbound connection from the dashboard is required.

## OCI runners: Run Command

Create a dynamic group before creating the runners when possible. A compartment-scoped rule supports current and future dedicated runners:

```text
instance.compartment.id = '<RUNNER_COMPARTMENT_OCID>'
```

Alternatively, use exact-instance rules for a smaller blast radius. Grant the dynamic group permission to retrieve commands targeted to itself:

```text
Allow dynamic-group <RUNNER_DYNAMIC_GROUP> to use instance-agent-command-execution-family in compartment id <RUNNER_COMPARTMENT_OCID> where request.instance.id=target.instance.id
```

The **Compute Instance Run Command** Oracle Cloud Agent plugin must be `RUNNING`. OCI documents that a newly added dynamic-group membership can take up to 30 minutes to begin polling. A command that remains `ACCEPTED` has not been picked up by the instance; verify this policy, egress TCP/443, and the agent log before running a workload.

Both OCI runners publish evidence through their instance principals:

```text
Allow dynamic-group <RUNNER_DYNAMIC_GROUP> to read buckets in compartment id <EVIDENCE_COMPARTMENT_OCID>
Allow dynamic-group <RUNNER_DYNAMIC_GROUP> to manage objects in compartment id <EVIDENCE_COMPARTMENT_OCID> where target.bucket.name='<EVIDENCE_BUCKET>'
```

### OCI NoSQL data-plane access

The NoSQL runner uses its instance principal. A minimal Phase 0 policy needs table metadata plus row reads/writes on the dedicated table:

```text
Allow dynamic-group <RUNNER_DYNAMIC_GROUP> to read nosql-tables in compartment id <TABLE_COMPARTMENT_OCID>
Allow dynamic-group <RUNNER_DYNAMIC_GROUP> to manage nosql-rows in compartment id <TABLE_COMPARTMENT_OCID> where target.nosql-table.name='<TABLE_NAME>'
```

Phase 1 additionally requires permission to alter the provisioned limits of that dedicated table. Use `manage nosql-tables` restricted by `target.nosql-table.name` where supported by the operation. Oracle documents the `nosql-tables`, `nosql-rows`, and `nosql-indexes` resource types in the [NoSQL security model](https://docs.oracle.com/en/cloud/paas/nosql-cloud/ttxsq/index.html) and [policy reference](https://docs.oracle.com/en/cloud/paas/nosql-cloud/odsql/index.html).

### ADB DynamoDB API access

The ADB runner needs the same Run Command and evidence-bucket policies. DynamoDB-API credentials and endpoint remain on the runner in its protected runtime configuration; they are never returned to the dashboard. The credentials must permit `ListTables`, `DescribeTable`, `GetItem`, and the idempotent write operation used by preload/mixed workloads. Phase 1 also needs `UpdateTable` on the dedicated table.

## AWS runner

The EC2 instance must be an online Systems Manager managed node. Its instance role needs:

- the Systems Manager managed-instance permissions, normally `AmazonSSMManagedInstanceCore`;
- `dynamodb:DescribeTable`, `dynamodb:GetItem`, and the required idempotent write operations on the dedicated table;
- `dynamodb:UpdateTable` only for Phase 1;
- `s3:PutObject` for `arn:aws:s3:::<EVIDENCE_BUCKET>/results/*`.

The operator identity needs at least `ec2:DescribeInstances`, `ssm:DescribeInstanceInformation`, `ssm:SendCommand`, `ssm:GetCommandInvocation`, `dynamodb:ListTables`, `dynamodb:DescribeTable`, `application-autoscaling:DescribeScalableTargets`, `s3:ListAllMyBuckets`, `s3:ListBucket`, and `s3:GetObject`, scoped to the benchmark resources whenever the API supports resource scoping. See the AWS [Run Command setup](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command-setting-up.html).

## Database and evidence resources

- One existing, dedicated table per selected product.
- Canonical key schema compatible with the suite (`pk` and `sk`).
- Provisioned capacity sufficient for the selected profile, with configurable autoscaling disabled for accepted fixed-capacity sessions.
- One private S3 bucket for AWS evidence and one private OCI Object Storage bucket for OCI evidence.
- The same dataset seed, key count, payload size, image digest, configuration hash, consistency mode, retries, and scheduled UTC T0 across compared targets.
- Explicit dashboard authorization for canonical preload writes.

The suite validates the table and strongly certifies the canonical dataset before scheduling workload. It stops before workload if runner readiness, resource validation, certification, hash equality, or another acceptance gate fails.

## Readiness checklist

1. `npm run check` passes locally.
2. Dashboard discovery shows the intended profiles, compartments, runners, tables, capacity, and evidence buckets.
3. AWS runner reports `SSM_ONLINE`; OCI runners report `RUN_COMMAND_RUNNING`.
4. A two-second `smoke.json` cloud run completes for each target independently.
5. Dataset certificates match before running a multi-target session.
6. The final immutable matrix preview shows the expected duration, operations/s, operations/minute, repetitions, consistency, mix, and concurrency model.


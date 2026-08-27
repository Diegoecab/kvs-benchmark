export function errorEvidence(error) {
  const metadata = error?.$metadata ?? {};
  const name = error?._errCode?._name || error?.errorCode?.name || error?.code?.name || error?.code || error?.Code || error?.name || "UnknownError";
  return {
    name: String(name),
    message: error?.message ? String(error.message).slice(0, 2048) : null,
    httpStatusCode: metadata.httpStatusCode ?? error?.statusCode ?? null,
    requestId: metadata.requestId ?? error?.requestId ?? null,
    attempts: metadata.attempts ?? null,
    totalRetryDelayMs: metadata.totalRetryDelay ?? null,
    fault: error?.$fault ?? null,
    retryable: error?.$retryable ?? null,
    stack: error?.stack ? String(error.stack).split("\n").slice(0, 12).join("\n") : null
  };
}


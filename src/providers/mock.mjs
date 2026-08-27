export async function createMockProvider({ config }) {
  const payload = "x".repeat(config.dataset.payloadBytes);
  return {
    async read(key) { await new Promise(resolve => setTimeout(resolve, 2)); return { version: 1, payload, key, attempts: 1 }; },
    async write(key, version) { await new Promise(resolve => setTimeout(resolve, 2)); return { version, payload, key, attempts: 1 }; },
    async close() {}
  };
}


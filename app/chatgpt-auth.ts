// Old Sites identity cannot be trusted on standalone hosting.
// Existing email accounts retain their IDs when data is explicitly imported.
export async function getChatGPTUser(): Promise<{userId: string} | null> { return null; }

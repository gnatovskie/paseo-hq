type Result = { state: 'running' | 'complete' | 'failed'; success: boolean; updated: boolean; message: string; details?: string };
type Rpc = (input: { action: 'start' | 'status'; jobId: string }) => Promise<Result>;
const restarting = (error: unknown) => /Plugin stopped|Plugin .*not running|Plugin is not available: paseo-hq|Plugin .*not found|Unknown plugin/i.test(String(error));

export async function syncPlugin(rpc: Rpc, jobId: string): Promise<Result> {
  const deadline = Date.now() + 240_000;
  try { const initial = await rpc({ action: 'start', jobId }); if (initial.state !== 'running') return initial; }
  catch (error) { if (!restarting(error)) throw error; }
  // The daemon rejects pending plugin RPCs during replacement. Read the durable
  // worker result after it comes back; a disconnect is never proof of success.
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const result = await rpc({ action: 'status', jobId });
      if (result.state !== 'running') return result;
    } catch (error) { if (!restarting(error)) throw error; }
  }
  throw new Error('Не удалось получить итог обновления Штаба за 4 минуты');
}

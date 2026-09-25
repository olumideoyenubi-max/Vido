import { createMockProvider } from './mock.js';
import { createReplicateProvider } from './replicate.js';
import { createFalProvider } from './fal.js';
import { createLocalProvider } from './local.js';

// Builds every backend that has credentials configured. The mock backend is
// on when nothing else is (so the app always works), or when ENABLE_MOCK=true.
export function createBackends(env = process.env) {
  const backends = {};
  if (env.FAL_KEY) backends.fal = createFalProvider({ key: env.FAL_KEY });
  if (env.REPLICATE_API_TOKEN) backends.replicate = createReplicateProvider({ token: env.REPLICATE_API_TOKEN });
  if (env.LOCAL_WORKER_URL) backends.local = createLocalProvider({ url: env.LOCAL_WORKER_URL, token: env.LOCAL_WORKER_TOKEN });

  const mock = env.ENABLE_MOCK?.toLowerCase();
  if (mock === 'true' || (mock !== 'false' && Object.keys(backends).length === 0)) backends.mock = createMockProvider();
  return backends;
}

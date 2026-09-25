import { createMockProvider } from './mock.js';
import { createReplicateProvider } from './replicate.js';
import { createFalProvider } from './fal.js';

export function createProvider(env = process.env) {
  const name = (env.VIDEO_PROVIDER ?? 'mock').toLowerCase();
  switch (name) {
    case 'mock':
      return createMockProvider();
    case 'replicate':
      return createReplicateProvider({
        token: env.REPLICATE_API_TOKEN,
        model: env.REPLICATE_MODEL || 'minimax/video-01',
      });
    case 'fal':
      return createFalProvider({
        key: env.FAL_KEY,
        model: env.FAL_MODEL || 'fal-ai/kling-video/v2.1/standard/text-to-video',
        imageModel: env.FAL_IMAGE_MODEL ?? 'fal-ai/kling-video/v2.1/standard/image-to-video',
      });
    default:
      throw new Error(`Unknown VIDEO_PROVIDER "${name}" (expected mock, replicate or fal)`);
  }
}

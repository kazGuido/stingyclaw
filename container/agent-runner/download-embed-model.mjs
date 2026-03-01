// Pre-download the local embedding model during Docker build so there's no cold start
import { pipeline, env } from '@xenova/transformers';

env.cacheDir = '/home/node/.stingyclaw/transformers';

console.log('Downloading Xenova/all-MiniLM-L6-v2 (quantized)...');
await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
console.log('Embedding model downloaded and cached.');

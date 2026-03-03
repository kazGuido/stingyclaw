/**
 * Lightweight semantic search for tools.
 * Uses pipeline('feature-extraction', Xenova/all-MiniLM-L6-v2) to embed tool
 * descriptions and match the user query to top-K tools.
 */

import { pipeline, env as xenovaEnv } from '@xenova/transformers';

xenovaEnv.cacheDir = '/home/node/.stingyclaw/transformers';

interface ToolDescription {
  name: string;
  description: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Embedder = any;

class SemanticToolSearch {
  private model: Embedder | null = null;
  private tools: ToolDescription[] = [];
  private embeddings: number[][] = [];
  private loaded = false;

  async load(toolRegistry: { tools: ToolDescription[] }): Promise<void> {
    if (this.loaded) return;

    console.log('[semantic-tool-search] Loading tool embeddings...');
    this.tools = toolRegistry.tools;
    this.embeddings = [];

    try {
      this.model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
      });
    } catch (err) {
      console.error('[semantic-tool-search] Failed to load embedding model:', err);
      throw err;
    }

    const texts = this.tools.map((t) => `${t.name}: ${t.description}`);
    console.log(`[semantic-tool-search] Encoding ${this.tools.length} tools...`);

    for (const text of texts) {
      const out = await this.model(text, { pooling: 'mean', normalize: true });
      this.embeddings.push(Array.from(out.data as Float32Array));
    }

    this.loaded = true;
    const dim = this.embeddings[0]?.length ?? 0;
    console.log(`[semantic-tool-search] Loaded ${this.tools.length} tools, embedding dimension: ${dim}`);
  }

  async searchAsync(query: string, topK: number = 3): Promise<Array<{ name: string; description: string; score: number }>> {
    if (!this.loaded || !this.model) {
      throw new Error('[semantic-tool-search] Not loaded');
    }

    if (this.tools.length === 0) {
      return [];
    }

    const out = await this.model(query, { pooling: 'mean', normalize: true });
    const queryVector = Array.from(out.data as Float32Array);

    const scores: Array<{ name: string; description: string; score: number }> = [];
    for (let i = 0; i < this.tools.length; i++) {
      const dotProduct = this.dot(queryVector, this.embeddings[i]);
      scores.push({
        name: this.tools[i].name,
        description: this.tools[i].description,
        score: dotProduct,
      });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, Math.min(topK, scores.length));
  }

  private dot(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }
}

export const semanticToolSearch = new SemanticToolSearch();

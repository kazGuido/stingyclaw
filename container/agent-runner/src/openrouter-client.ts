/**
 * Simple OpenRouter HTTP client - no Vercel SDK
 * Full control over request/response format
 */

// Simple log function matching agent-runner style
function log(msg: string): void {
  console.error(`[openrouter-client] ${msg}`);
}

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface OpenRouterResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  error?: {
    message: string;
    code: number;
  };
}

export async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  tools?: OpenRouterTool[],
  maxTokens = 8192,
): Promise<OpenRouterResponse> {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  log(`Calling OpenRouter: model=${model}, messages=${messages.length}, tools=${tools?.length || 0}`);
  
  // Debug: log the request body (truncated)
  const debugBody = JSON.stringify(body).slice(0, 500);
  log(`Request body (truncated): ${debugBody}...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/kazGuido/stingyclaw',
      'X-Title': 'Stingyclaw',
      'X-Transform': 'none', // Don't transform messages
    },
    body: JSON.stringify(body),
  });

  const data = await response.json() as OpenRouterResponse;

  if (!response.ok) {
    log(`OpenRouter API error: status=${response.status}, error=${data.error?.message || 'Unknown'}`);
    throw new Error(`OpenRouter ${response.status}: ${data.error?.message || 'Unknown error'}`);
  }

  if (data.error) {
    log(`OpenRouter returned error: ${data.error.message}`);
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  log(`OpenRouter response received: finish_reason=${data.choices?.[0]?.finish_reason || 'unknown'}`);

  return data;
}

/**
 * Convert our tool format to OpenRouter tool format
 */
export function convertTools(tools: Record<string, { description: string; parameters: ReturnType<typeof import('ai').jsonSchema> }>): OpenRouterTool[] {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function' as const,
    function: {
      name,
      description: tool.description,
      parameters: tool.parameters as any,
    },
  }));
}

/**
 * Build messages in OpenRouter format
 */
export function buildMessages(
  systemPrompt: string,
  history: Array<{ role: string; content?: string | null; tool_call_id?: string; tool_calls?: any[] }>,
): OpenRouterMessage[] {
  const messages: OpenRouterMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const h of history) {
    if (h.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: h.content || null,
        tool_calls: h.tool_calls,
      });
    } else if (h.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: h.tool_call_id || '',
        content: h.content || '',
      });
    } else {
      messages.push({
        role: h.role as 'user' | 'system',
        content: h.content || '',
      });
    }
  }

  return messages;
}

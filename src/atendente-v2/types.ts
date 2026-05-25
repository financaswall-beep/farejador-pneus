export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface OpenAIToolsResponse {
  type: 'text' | 'tool_calls';
  content?: string;
  tool_calls?: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface AgentV2JobInput {
  jobId: string;
  conversationId: string;
  triggerMessageId: string;
  environment: string;
}

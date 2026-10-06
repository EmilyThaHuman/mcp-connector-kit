/**
 * MCP error envelope helpers — zero deps so they can run anywhere.
 *
 * The MCP spec returns tool errors as part of the normal `result` body
 * (not as JSON-RPC errors), so handlers must return the same shape on
 * success and failure: `{ content: [...], isError?: true }`.
 */

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export function mcpError(message: string): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

/**
 * Run `fn` and return its result. If it throws, return an MCP error envelope
 * carrying the exception's message instead of letting the throw escape to the
 * transport layer.
 */
export async function errorBoundary<T extends McpToolResult>(
  fn: () => Promise<T>,
): Promise<T | McpToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return mcpError(message);
  }
}

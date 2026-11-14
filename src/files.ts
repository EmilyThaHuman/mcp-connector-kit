import type { KitEnv } from './jwt.js';

export interface ConnectorFile {
  library_item_id?: string;
  file_uri?: string;
  name?: string;
  content_type?: string;
}

export async function connectorFileRequest(
  jwt: string, env: KitEnv, path: string, init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${env.ZEROTWO_API_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${jwt}` },
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || `ZeroTwo file service failed (${response.status})`));
  return result;
}

export async function readConnectorFile(reference: string | ConnectorFile, jwt: string, env: KitEnv) {
  const file = typeof reference === 'string' ? { file_uri: reference } : reference;
  let uri = file.file_uri;
  let name = file.name;
  let mimeType = file.content_type;
  const itemId = file.library_item_id || uri?.match(/^zerotwo-library:\/\/(.+)$/i)?.[1];
  if (itemId) {
    const resolved = await connectorFileRequest(jwt, env, '/internal/mcp/resolve-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_item_id: itemId }),
    });
    uri = String(resolved.file_uri);
    name ||= String(resolved.name);
    mimeType ||= String(resolved.mime_type);
  }
  if (!uri || !/^https:\/\//i.test(uri)) {
    throw new Error('Use a ZeroTwo Library handle or HTTPS file URL; upload local files to Library first');
  }
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`Attachment download failed (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Attachment download returned no bytes');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 25 * 1024 * 1024) throw new Error('Attachment exceeds the 25 MB file limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return {
    bytes,
    filename: name || decodeURIComponent(new URL(uri).pathname.split('/').pop() || 'attachment'),
    mimeType: mimeType || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
  };
}

export async function materializeConnectorFile(
  bytes: Uint8Array,
  metadata: { name: string; mimeType: string; messageId: string; attachmentId: string; startLine?: number },
  jwt: string, env: KitEnv,
) {
  const query = new URLSearchParams({
    name: metadata.name, mime_type: metadata.mimeType,
    message_id: metadata.messageId, attachment_id: metadata.attachmentId,
    start_line: String(metadata.startLine || 1),
  });
  return connectorFileRequest(jwt, env, `/internal/mcp/materialize-file?${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes).buffer,
  });
}

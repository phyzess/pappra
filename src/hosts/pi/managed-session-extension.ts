import fs from 'node:fs';
import { createHash } from 'node:crypto';

const METADATA_ENV = 'PAPPRA_MANAGED_PI_METADATA_FILE';
const SCHEMA = 'harness-collab/pi-managed-session/1';

type SessionContext = {
  cwd: string;
  sessionManager: {
    getSessionFile(): string | null | undefined;
    getSessionId(): string;
  };
};

type InputEvent = {
  text: string;
  source?: string;
  streamingBehavior?: string;
};

type ManagedExtensionApi = {
  on(
    event: 'session_start' | 'session_shutdown' | 'agent_settled',
    handler: (_event: unknown, context: SessionContext) => void,
  ): unknown;
  on(
    event: 'input',
    handler: (event: InputEvent) => { action: 'continue' | 'handled' } | void,
  ): unknown;
};

type MetadataRecord = {
  schema: typeof SCHEMA;
  at: string;
  type: string;
  [key: string]: unknown;
};

function appendMetadata(record: MetadataRecord): boolean {
  const file = process.env[METADATA_ENV];
  if (!file || !file.startsWith('/')) return false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'a', 0o600);
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let written = 0;
    while (written < line.length) {
      written += fs.writeSync(fd, line, written, line.length - written);
    }
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The record was either persisted or its caller observes failure.
      }
    }
  }
}

function sessionStartRecord(context: SessionContext): MetadataRecord {
  return {
    schema: SCHEMA,
    type: 'session_start',
    at: new Date().toISOString(),
    cwd: context.cwd,
    session_file: context.sessionManager.getSessionFile() ?? null,
    session_id: context.sessionManager.getSessionId(),
  };
}

export default function managedPiSessionExtension(
  pi: ManagedExtensionApi,
): void {
  pi.on('session_start', (_event, context) => {
    appendMetadata(sessionStartRecord(context));
  });

  pi.on('agent_settled', (_event, context) => {
    appendMetadata({
      schema: SCHEMA,
      type: 'agent_settled',
      session_id: context.sessionManager.getSessionId(),
      cwd: context.cwd,
      session_file: context.sessionManager.getSessionFile() ?? null,
      at: new Date().toISOString(),
    });
  });

  pi.on('session_shutdown', (_event, context) => {
    appendMetadata({
      schema: SCHEMA,
      type: 'session_shutdown_observed',
      at: new Date().toISOString(),
      cwd: context.cwd,
      session_file: context.sessionManager.getSessionFile() ?? null,
    });
  });

  pi.on('input', (event) => {
    const text = typeof event.text === 'string' ? event.text : '';
    const persisted = appendMetadata({
      schema: SCHEMA,
      type: 'input_event_observed',
      at: new Date().toISOString(),
      source: typeof event.source === 'string' ? event.source : 'unknown',
      streaming_behavior:
        typeof event.streamingBehavior === 'string'
          ? event.streamingBehavior
          : null,
      text_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      text_utf8_bytes: Buffer.byteLength(text, 'utf8'),
    });
    // The PTY ingress has already been write-ahead journaled. If the semantic observation
    // cannot be persisted, do not let this input proceed without its controller evidence.
    return { action: persisted ? 'continue' : 'handled' };
  });
}

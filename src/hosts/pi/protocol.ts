import { object } from '../../infra/validation.js';
export interface PiData {
  [key: string]: unknown;
  sessionId?: string;
  sessionFile?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  messageCount?: number;
  disposition?: string;
  steering?: unknown[];
  followUp?: unknown[];
}
export interface PiRecord {
  [key: string]: unknown;
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: PiData;
}
export function isPiRecord(value: unknown): value is PiRecord {
  if (!object(value) || typeof value['type'] !== 'string') return false;
  for (const key of ['id', 'command', 'error'])
    if (value[key] !== undefined && typeof value[key] !== 'string')
      return false;
  if (value['success'] !== undefined && typeof value['success'] !== 'boolean')
    return false;
  const data = value['data'];
  if (data === undefined) return true;
  if (!object(data)) return false;
  for (const key of ['sessionId', 'sessionFile', 'disposition'])
    if (data[key] !== undefined && typeof data[key] !== 'string') return false;
  for (const key of ['isStreaming', 'isCompacting'])
    if (data[key] !== undefined && typeof data[key] !== 'boolean') return false;
  for (const key of ['pendingMessageCount', 'messageCount'])
    if (data[key] !== undefined && typeof data[key] !== 'number') return false;
  for (const key of ['steering', 'followUp'])
    if (data[key] !== undefined && !Array.isArray(data[key])) return false;
  return true;
}

import { object } from '../../infra/validation.js';

export interface NativeItem {
  [key: string]: unknown;
  type?: string;
  text?: string;
  status?: string;
  exitCode?: number;
  aggregatedOutput?: string;
}
export interface NativeEntry {
  [key: string]: unknown;
  id?: string;
  status?: string;
  item?: NativeItem;
}
export interface NativeThread {
  [key: string]: unknown;
  id?: string;
  cwd?: string;
  status?: { type: string };
}
export interface NativeReply {
  [key: string]: unknown;
  thread?: NativeThread;
  turn?: NativeEntry;
  data?: NativeEntry[];
}
export interface NativeParams {
  [key: string]: unknown;
  threadId?: string;
  turn?: NativeEntry;
}
export interface NativeRecord {
  id?: string | number;
  method?: string;
  params?: NativeParams;
  result?: NativeReply;
  error?: { message?: string };
}
export interface NativeEvent {
  seq: number;
  method: string;
  params: NativeParams | null;
  at: string;
  error?: never;
}
const optionalString = (value: unknown) =>
  value === undefined || typeof value === 'string';
function isEntry(value: unknown): value is NativeEntry {
  const item = object(value) ? value['item'] : undefined;
  return (
    object(value) &&
    optionalString(value['id']) &&
    optionalString(value['status']) &&
    (value['item'] === undefined ||
      (object(value['item']) &&
        object(item) &&
        ['type', 'text', 'status', 'aggregatedOutput'].every((key) =>
          optionalString(item[key]),
        ) &&
        (value['item']['exitCode'] === undefined ||
          typeof value['item']['exitCode'] === 'number')))
  );
}
export function isReply(value: unknown): value is NativeReply {
  return (
    object(value) &&
    (value['thread'] === undefined ||
      (object(value['thread']) &&
        optionalString(value['thread']['id']) &&
        optionalString(value['thread']['cwd']) &&
        (value['thread']['status'] === undefined ||
          (object(value['thread']['status']) &&
            typeof value['thread']['status']['type'] === 'string')))) &&
    (value['turn'] === undefined || isEntry(value['turn'])) &&
    (value['data'] === undefined ||
      (Array.isArray(value['data']) && value['data'].every(isEntry)))
  );
}
export function isRecord(value: unknown): value is NativeRecord {
  return (
    object(value) &&
    (value['id'] === undefined ||
      typeof value['id'] === 'string' ||
      typeof value['id'] === 'number') &&
    optionalString(value['method']) &&
    (value['params'] === undefined ||
      (object(value['params']) &&
        optionalString(value['params']['threadId']) &&
        (value['params']['turn'] === undefined ||
          isEntry(value['params']['turn'])))) &&
    (value['result'] === undefined || isReply(value['result'])) &&
    (value['error'] === undefined ||
      (object(value['error']) && optionalString(value['error']['message'])))
  );
}

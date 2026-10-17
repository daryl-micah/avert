// The public API surface of one SDK version, as seen from its root client class.
export interface SurfaceOp {
  resource: string[];        // property path from the client, e.g. ["chat","completions"]
  method: string;
  deprecated: boolean;
  params: Record<string, ParamInfo>;
}
export interface ParamInfo { deprecated: boolean; doc?: string }
export type Surface = Map<string, SurfaceOp>; // key: snake-cased "chat.completions.create"

export const MAX_DEPTH = 5;
export const MAX_OPS = 20000;

/** Property / method names that are SDK plumbing, not API resources or operations. */
export const SKIP_MEMBERS = new Set([
  'withRawResponse', 'withStreamingResponse', 'with_raw_response', 'with_streaming_response', 'withOptions', 'with_options',
  'request', 'requestAPIList', 'getAPIList', 'copy', 'constructor', 'toJSON', 'apiKey', 'baseURL', 'baseUrl', 'timeout', 'maxRetries',
  'fetch', 'httpClient', 'buildRequest', 'webhooks', 'errors', 'on', 'once', 'off', 'emit', 'setAppInfo', 'getApiField', 'getConstant',
  'getClientUserAgent', 'getTelemetryEnabled', 'StripeResource', 'rawRequest', 'parseThinEvent', 'parseEventNotification',
]);

/** First ~200 chars of a doc comment / docstring, whitespace-collapsed. */
export function docText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/^\s*\/\*\*|\*\/\s*$|^\s*\*\s?|^\s*(\"\"\"|''')|(\"\"\"|''')\s*$/gm, ' ').replace(/@\w+.*$/s, '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 200) : undefined;
}

import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';

import webPush from 'web-push';

import { type PushPayloadV1 } from './payload.js';
import { parseApprovedPushEndpoint } from './validation.js';

export type WebPushSendResult =
  | Readonly<{ type: 'response'; statusCode: number }>
  | Readonly<{ type: 'network-error' }>
  | Readonly<{ type: 'timeout' }>
  | Readonly<{ type: 'aborted' }>;

export type SendWebPushInput = Readonly<{
  subscription: Readonly<{
    endpoint: string;
    p256dh: string;
    auth: string;
  }>;
  payload: PushPayloadV1;
  topic: string;
  signal: AbortSignal;
  timeoutMs?: number;
}>;

export type HttpsRequestFunction = (
  url: string | URL,
  options: Record<string, unknown>,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface WebPushSender {
  send(input: SendWebPushInput): Promise<WebPushSendResult>;
}

export function createWebPushSender(
  vapid: Readonly<{
    subject: string;
    publicKey: string;
    privateKey: string;
  }>,
  requestFn: HttpsRequestFunction = httpsRequest as unknown as HttpsRequestFunction,
): WebPushSender {
  return {
    async send(input: SendWebPushInput): Promise<WebPushSendResult> {
      let endpoint: string;
      try {
        endpoint = parseApprovedPushEndpoint(input.subscription.endpoint);
      } catch {
        return { type: 'response', statusCode: 400 };
      }

      const payloadJson = JSON.stringify(input.payload);

      let requestDetails: {
        endpoint: string;
        method: string;
        headers: Record<string, string>;
        body: Buffer;
      };
      try {
        requestDetails = webPush.generateRequestDetails(
          {
            endpoint,
            keys: {
              p256dh: input.subscription.p256dh,
              auth: input.subscription.auth,
            },
          },
          payloadJson,
          {
            TTL: 24 * 60 * 60,
            urgency: 'normal',
            topic: input.topic,
            contentEncoding: 'aes128gcm',
            vapidDetails: {
              subject: vapid.subject,
              publicKey: vapid.publicKey,
              privateKey: vapid.privateKey,
            },
          },
        );
      } catch {
        return { type: 'response', statusCode: 400 };
      }

      return new Promise<WebPushSendResult>((resolve) => {
        const timeoutMs = input.timeoutMs ?? 10_000;

        let timer: NodeJS.Timeout | undefined;
        const cleanedUp = { current: false };

        function cleanup() {
          if (cleanedUp.current) return;
          cleanedUp.current = true;
          if (timer) clearTimeout(timer);
        }

        if (input.signal.aborted) {
          cleanup();
          resolve({ type: 'aborted' });
          return;
        }

        const req = requestFn(
          requestDetails.endpoint,
          {
            method: requestDetails.method,
            headers: requestDetails.headers,
            rejectUnauthorized: true,
            timeout: timeoutMs,
          },
          (response: IncomingMessage) => {
            cleanup();
            response.resume();
            response.on('end', () => {
              resolve({ type: 'response', statusCode: response.statusCode ?? 0 });
            });
          },
        );

        req.on('error', (error: Error & { code?: string }) => {
          cleanup();
          if (error.name === 'AbortError') {
            resolve({ type: 'aborted' });
          } else {
            resolve({ type: 'network-error' });
          }
        });

        req.on('timeout', () => {
          cleanup();
          req.destroy();
          resolve({ type: 'timeout' });
        });

        if (input.signal instanceof AbortSignal) {
          if (input.signal.aborted) {
            cleanup();
            req.destroy();
            resolve({ type: 'aborted' });
            return;
          }
          const onAbort = () => {
            cleanup();
            req.destroy();
            resolve({ type: 'aborted' });
          };
          input.signal.addEventListener('abort', onAbort, { once: true });
          req.on('close', () => {
            input.signal.removeEventListener('abort', onAbort);
          });
        }

        timer = setTimeout(() => {
          cleanup();
          req.destroy();
          resolve({ type: 'timeout' });
        }, timeoutMs);

        req.write(requestDetails.body);
        req.end();
      });
    },
  };
}

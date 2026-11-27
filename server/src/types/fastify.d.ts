import 'fastify';
import type { SafeUser } from '../modules/auth/types.js';
import type { OperatorSessionContext } from '../modules/operator/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: SafeUser;
    sessionTokenHash?: string;
    currentSessionId?: string;
    operatorSession?: OperatorSessionContext;
  }
}

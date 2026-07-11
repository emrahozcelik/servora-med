import 'fastify';
import type { SafeUser } from '../modules/auth/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: SafeUser;
    sessionTokenHash?: string;
  }
}

export type PublicHealthStatus = {
  status: 'ok';
};

export function getPublicHealthStatus(): PublicHealthStatus {
  return { status: 'ok' };
}


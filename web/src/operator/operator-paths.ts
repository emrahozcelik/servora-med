export const operatorPaths = {
  root: '/operator',
  modules: '/operator/modules',
} as const;

/** `/operator` and anything below it belongs to the installation-operator area. */
export function isOperatorPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return normalized === operatorPaths.root || normalized.startsWith(`${operatorPaths.root}/`);
}

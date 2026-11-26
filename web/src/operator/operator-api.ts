import {
  ApiError, boolean, json, number, object, request, string,
} from '../services/api';

/**
 * Installation-operator client (MOD-002). Every call targets `/api/operator`
 * and relies on the operator-only cookie (`servora_operator_session`); nothing
 * here touches the customer session or the customer APIs.
 */

export type OperatorProfile = {
  id: string;
  name: string;
  email: string;
  capabilities: string[];
};

export type InstallationModuleSource = 'ENV_TAKEOVER' | 'OPERATOR';

export type InstallationModule = {
  key: string;
  label: string;
  enabled: boolean;
  version: number;
  source: InstallationModuleSource;
  updatedAt: string;
};

const MODULE_SOURCES: readonly InstallationModuleSource[] = ['ENV_TAKEOVER', 'OPERATOR'];

function invalid(field: string): never {
  throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
}

export function parseOperatorProfile(value: unknown): OperatorProfile {
  const operator = object(value);
  if (!Array.isArray(operator.capabilities)) invalid('capabilities');
  const capabilities = operator.capabilities.map((entry) => string(entry, 'capabilities'));
  return {
    id: string(operator.id, 'id'),
    name: string(operator.name, 'name'),
    email: string(operator.email, 'email'),
    capabilities,
  };
}

export function parseInstallationModule(value: unknown): InstallationModule {
  const entry = object(value);
  const version = number(entry.version, 'version');
  if (!Number.isInteger(version) || version < 0) invalid('version');
  const source = string(entry.source, 'source');
  if (!MODULE_SOURCES.includes(source as InstallationModuleSource)) invalid('source');
  const updatedAt = string(entry.updatedAt, 'updatedAt');
  if (Number.isNaN(Date.parse(updatedAt))) invalid('updatedAt');
  return {
    key: string(entry.key, 'key'),
    label: string(entry.label, 'label'),
    enabled: boolean(entry.enabled, 'enabled'),
    version,
    source: source as InstallationModuleSource,
    updatedAt,
  };
}

export async function operatorLogin(credentials: { email: string; password: string }) {
  const body = object(await request('/api/operator/login', json('POST', credentials)));
  return parseOperatorProfile(body.operator);
}

export async function operatorLogout() {
  await request('/api/operator/logout', { method: 'POST' });
}

/** `null` means there is no valid operator session (401), not a failure. */
export async function getOperatorSession(): Promise<OperatorProfile | null> {
  try {
    return parseOperatorProfile(object(await request('/api/operator/me')).operator);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function listInstallationModules(): Promise<InstallationModule[]> {
  const modules = object(await request('/api/operator/modules')).modules;
  if (!Array.isArray(modules)) invalid('modules');
  return modules.map(parseInstallationModule);
}

export async function setInstallationModuleEnabled(
  key: string,
  input: { enabled: boolean; expectedVersion: number },
): Promise<InstallationModule> {
  const body = object(await request(
    `/api/operator/modules/${encodeURIComponent(key)}`,
    json('PUT', input),
  ));
  const updated = parseInstallationModule(body.module);
  if (updated.key !== key) invalid('key');
  return updated;
}

export function isOperatorSessionEnded(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function isModuleVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'MODULE_VERSION_CONFLICT';
}

/**
 * Turkish copy for operator failures. Only the codes the contract defines are
 * mapped; anything else keeps the server/transport message.
 */
export function operatorErrorMessage(
  error: unknown,
  context: 'login' | 'modules' | 'update',
): string {
  if (!(error instanceof ApiError)) {
    return context === 'login'
      ? 'Giriş yapılamadı. Lütfen tekrar deneyin.'
      : 'İşlem tamamlanamadı. Lütfen tekrar deneyin.';
  }
  if (error.code === 'NETWORK_ERROR') return error.message;
  if (error.status === 401 && context === 'login') return 'E-posta veya parola hatalı.';
  if (error.status === 401) return 'Operatör oturumunuz sona erdi. Lütfen yeniden giriş yapın.';
  if (error.status === 400) {
    return context === 'login'
      ? 'E-posta ve parola alanlarını doldurun.'
      : 'İstek geçersiz. Sayfayı yenileyip tekrar deneyin.';
  }
  if (error.code === 'INVALID_ORIGIN') {
    return 'İstek bu adresten kabul edilmedi. Uygulamanın tanımlı adresinden bağlanın.';
  }
  if (error.status === 403) return 'Bu hesabın modül yönetimi yetkisi yok.';
  if (error.status === 404 && context === 'update') return 'Bu modül artık yönetilebilir değil. Listeyi yenileyin.';
  if (error.status === 409 && error.code === 'MODULE_VERSION_CONFLICT') {
    return 'Modül durumu başka bir oturumda değişti. Güncel durumu yükleyip değişikliği yeniden uygulayın.';
  }
  if (error.code === 'MODULE_STATE_UNAVAILABLE') {
    return 'Modül durumu şu anda okunamıyor. Bir süre sonra tekrar deneyin; sorun sürerse sunucu kayıtlarını kontrol edin.';
  }
  if (error.status === 429) {
    return error.retryAfterSeconds
      ? `Çok fazla deneme yapıldı. ${error.retryAfterSeconds} saniye sonra tekrar deneyin.`
      : 'Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.';
  }
  return error.message;
}

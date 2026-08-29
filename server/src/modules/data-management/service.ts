import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { DataManagementReadModel } from './repository.js';

const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');

function requireAdmin(actor: Pick<SafeUser, 'role'>) {
  if (actor.role !== 'ADMIN') throw forbidden();
}

export class DataManagementService {
  constructor(private readonly repository: DataManagementReadModel) {}

  async getSummary(actor: SafeUser) {
    requireAdmin(actor);
    return this.repository.getSummary(actor.organizationId);
  }
}

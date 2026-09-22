import type { CurrentUser } from '../services/api';
import type { RouteId, RouteParams } from './route-identity';

/**
 * Single reusable route-access rule (Slice 3B).
 *
 * Mirrors the exact AppRouter guards so context-return validation reuses the
 * same policy instead of encoding a second role matrix. Returns true when the
 * given user may view the route; false otherwise. Never throws.
 *
 * - overview/calendar/messages: capability-gated (else AppRouter redirects).
 * - reports/*, users/*, staffReport, productCreate, followUpCreate,
 *   settingsDataManagement/DemoData/BackupRecovery: role/capability-gated
 *   (else AppRouter renders ForbiddenView).
 * - staffProfile: STAFF scoped to own id; MANAGER/ADMIN all.
 * - everything else authenticated: true.
 */
export function canAccessRoute(
  id: RouteId,
  user: CurrentUser,
  params: RouteParams = {},
): boolean {
  switch (id) {
    case 'overview':
      return user.capabilities?.overviewDashboard === true;
    case 'calendar':
      return user.capabilities?.calendar === true;
    case 'messages':
      return user.capabilities?.messaging === true;
    case 'followUpCreate':
    case 'productCreate':
    case 'reports':
    case 'reportStaff':
    case 'reportCustomers':
    case 'reportDeliveries':
    case 'reportApprovals':
    case 'reportSalesFollowUp':
    case 'staffReport':
      return user.role !== 'STAFF';
    case 'users':
    case 'userCreate':
    case 'userDetail':
    case 'settingsDataManagement':
    case 'settingsDemoData':
      return user.role === 'ADMIN';
    case 'settingsBackupRecovery':
      return user.role === 'ADMIN' && user.capabilities?.backup === true;
    case 'staffProfile': {
      if (user.role === 'STAFF') {
        return typeof params.staffUserId === 'string' && params.staffUserId === user.id;
      }
      return true;
    }
    default:
      return true;
  }
}

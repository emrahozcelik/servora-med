import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { DeliveryCreateView } from './DeliveryCreate';
import { CustomerCreateScreen, CustomerListScreen } from './CustomerList';
import { CustomerDetailScreen } from './CustomerDetail';
import { ContactDetailScreen } from './ContactManagement';
import { JobDetailScreen } from './JobDetail';
import { JobWorkspace } from './jobs/JobWorkspace';
import { StaffProfilesScreen } from './StaffProfiles';
import { UserManagementScreen } from './UserManagement';
import { ProductCreateScreen } from './ProductForm';
import { ProductDetailScreen } from './ProductDetail';
import { ProductListScreen } from './ProductList';
import { paths } from './paths';
import type { CurrentUser, ReferenceCustomer } from './services/api';

export { paths } from './paths';

type AppRouterProps = {
  user: CurrentUser;
  customers: ReferenceCustomer[];
  notice: string;
  onClearNotice: () => void;
  onDeliveryCreated: () => void;
};

function ForbiddenView() {
  return <main className="workspace"><div className="workspace-message" role="alert">
    <h1>Bu alana erişim yetkiniz yok</h1>
    <p>Bu sayfayı görüntülemek için gerekli role sahip değilsiniz.</p>
    <Link className="secondary-button" to={paths.jobs}>İşlere dön</Link>
  </div></main>;
}

function NotFoundView() {
  return <main className="workspace"><div className="workspace-message">
    <h1>Sayfa bulunamadı</h1>
    <p>Bağlantı değişmiş veya sayfa kaldırılmış olabilir.</p>
    <Link className="secondary-button" to={paths.jobs}>İşlere dön</Link>
  </div></main>;
}

function JobDetailRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { jobCardId } = useParams();
  const navigate = useNavigate();
  if (!jobCardId) return <NotFoundView />;
  return <JobDetailScreen jobId={jobCardId} user={user} onBack={() => navigate(paths.jobs)} onChanged={() => {}} />;
}

function StaffRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { staffUserId } = useParams();
  const navigate = useNavigate();
  if (user.role === 'STAFF' && staffUserId && staffUserId !== user.id) return <ForbiddenView />;
  return <StaffProfilesScreen user={user} initialStaffUserId={staffUserId} onBack={() => navigate(paths.jobs)}
    onOpenProfile={(id) => navigate(paths.staffProfile(id))} onProfileBack={() => navigate(paths.staff)} />;
}

export function CustomerRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { customerId } = useParams();
  if (!customerId) return <NotFoundView />;
  return <CustomerDetailScreen key={customerId} customerId={customerId} user={user} />;
}

export function ContactRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { customerId, contactId } = useParams();
  if (!customerId || !contactId) return <NotFoundView />;
  return <ContactDetailScreen key={`${customerId}:${contactId}`} customerId={customerId} contactId={contactId} canManage={user.role !== 'STAFF'} />;
}

function ProductRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { productId } = useParams();
  if (!productId) return <NotFoundView />;
  return <ProductDetailScreen key={productId} productId={productId} user={user} />;
}

export function AppRouter({ user, customers, notice, onClearNotice, onDeliveryCreated }: AppRouterProps) {
  const navigate = useNavigate();
  return <>
    <Routes>
      <Route path="/" element={<Navigate to={paths.jobs} replace />} />
      <Route path="/login" element={<Navigate to={paths.jobs} replace />} />
      <Route path={paths.jobs} element={<JobWorkspace user={user} notice={notice}
        onCreate={() => { onClearNotice(); navigate(paths.newDelivery); }}
        onCommand={(intent) => navigate(paths.job(intent.jobId))} />} />
      <Route path={paths.newDelivery} element={<DeliveryCreateView user={user} customers={customers} onCancel={() => navigate(paths.jobs)}
        onCreated={() => { onDeliveryCreated(); navigate(paths.jobs); }} />} />
      <Route path="/jobs/:jobCardId" element={<JobDetailRoute user={user} />} />
      <Route path={paths.users} element={user.role === 'ADMIN'
        ? <UserManagementScreen onBack={() => navigate(paths.jobs)} /> : <ForbiddenView />} />
      <Route path={paths.staff} element={<StaffRoute user={user} />} />
      <Route path="/staff/:staffUserId" element={<StaffRoute user={user} />} />
      <Route path={paths.customers} element={<CustomerListScreen user={user} />} />
      <Route path={paths.newCustomer} element={user.role === 'STAFF' ? <ForbiddenView /> : <CustomerCreateScreen user={user} />} />
      <Route path="/customers/:customerId" element={<CustomerRoute user={user} />} />
      <Route path="/customers/:customerId/contacts/:contactId" element={<ContactRoute user={user} />} />
      <Route path={paths.products} element={<ProductListScreen user={user} />} />
      <Route path={paths.newProduct} element={user.role === 'STAFF' ? <ForbiddenView />
        : <ProductCreateScreen onCancel={() => navigate(paths.products)} onCreated={(product) => navigate(paths.product(product.id))} />} />
      <Route path="/products/:productId" element={<ProductRoute user={user} />} />
      <Route path="*" element={<NotFoundView />} />
    </Routes>
  </>;
}

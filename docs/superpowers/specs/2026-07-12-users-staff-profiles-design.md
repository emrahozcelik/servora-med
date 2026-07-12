# Servora-Med Users and Staff Profiles Design

**Date:** 2026-07-12  
**Status:** Approved design, awaiting written-spec review  
**Slice:** 04 — Users and Staff Profiles

## 1. Goal

Replace seed-only people setup with role-aware user administration and first-class Staff profiles. The slice must let an Admin create and maintain users, let Managers read users and maintain Staff profiles, let Staff read only their own profile, and derive operational counters from persisted JobCards.

The first vertical path is:

```text
Admin creates Staff with profile and temporary password
→ Staff signs in and must change password
→ Staff reads own profile and JobCard counters
→ Manager reads and updates the Staff profile
→ Admin deactivates the user and sessions are revoked
```

## 2. Scope

### In scope

- Organization-scoped user list and safe user detail
- Admin creation of Admin, Manager, and Staff users
- Admin update of user name, permitted role changes, and active state
- Admin-set temporary password with mandatory password change
- One-to-one Staff profile linked to a `STAFF` user
- Staff profile title, phone, region, manager, and notes
- Admin/Manager Staff list and Staff detail
- Staff own-profile read
- Persisted JobCard counters on Staff profile summaries
- Mobile, keyboard, zoom/reflow, reduced-motion, and semantic accessibility acceptance

### Out of scope

- Staff-to-Manager/Admin promotion and profile archival
- Profiles for Admin or Manager users
- User deletion
- Email delivery of credentials or password-reset links
- User-generated or reusable passwords
- Monthly targets, revenue, margin, inventory, or accounting metrics
- Product-purpose quantity reporting and delivery history UI
- Team hierarchy beyond one optional assigned Manager
- Bulk import, bulk actions, avatar upload, or directory synchronization
- New frontend router, state framework, UI framework, or realtime transport

## 3. Domain Boundary

Users and Staff profiles form one `people` domain boundary for this slice. Authentication continues to own credential verification and sessions, while the people service coordinates user administration, profile lifecycle, role invariants, and the transactions that span users, profiles, and session revocation.

HTTP remains split by intent:

- `/api/users` exposes organization user administration and safe user reads.
- `/api/staff` exposes Staff profile reads, profile maintenance, and operational summaries.
- `/api/auth` continues to own login, logout, current identity, and password change.

The boundary may use focused repository and service files internally. It must not split user creation and Staff profile creation across independently committed transactions.

## 4. Data Model

Migration `003_people.sql` adds `staff_profiles`:

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | primary key |
| `organization_id` | UUID | not null, references `organizations` |
| `user_id` | UUID | not null, unique, references `users` |
| `title` | VARCHAR(255) | nullable |
| `phone` | VARCHAR(50) | nullable |
| `region` | VARCHAR(100) | nullable |
| `manager_user_id` | UUID | nullable, references `users` |
| `notes` | TEXT | nullable |
| `created_at` | TIMESTAMPTZ | not null, defaults to current time |
| `updated_at` | TIMESTAMPTZ | not null, defaults to current time |

The profile has no `is_active` or target column. Its lifecycle and availability follow `users.is_active`. Application validation and tests enforce that the profile user belongs to the profile organization and has role `STAFF`, while an assigned manager belongs to the same organization, is active, and has role `MANAGER`.

The existing `users.must_change_password` column remains the sole mandatory-password-change flag. Raw or temporary passwords are never persisted or returned by user APIs.

## 5. Role and Lifecycle Rules

### Profile eligibility

- Every newly created `STAFF` user must receive a profile in the same transaction.
- `ADMIN` and `MANAGER` users must not receive Staff profiles.
- A Staff profile cannot be created for a user in another organization.
- A Manager assignment is optional. When present, it must identify an active `MANAGER` user in the same organization.

### Role changes

- `ADMIN` to `MANAGER` and `MANAGER` to `ADMIN` are allowed for an Admin actor, subject to the final-active-Admin rule.
- `ADMIN` or `MANAGER` to `STAFF` requires a Staff profile payload and creates the profile in the same transaction.
- `STAFF` to `MANAGER` or `ADMIN` is rejected with `STAFF_ROLE_CHANGE_NOT_SUPPORTED` in MVP.
- An actor cannot change their own role.

### Activation

- Only Admin may activate or deactivate a user.
- An actor cannot deactivate their own account.
- The last active Admin cannot be deactivated or changed away from the Admin role.
- Deactivation and revocation of all target-user sessions occur in one transaction.
- Inactive users cannot log in and are hidden from the default active Staff list.

### Temporary password and forced change

- Admin enters the temporary password; the server validates the existing password policy and persists only its hash.
- Reset sets `must_change_password = true` and revokes all target-user sessions in one transaction.
- A newly created user also starts with `must_change_password = true`.
- After login, a user with this flag may access only current identity, password change, and logout endpoints.
- Successful password change clears `must_change_password`, revokes the current session with all other sessions, and requires a fresh login.

## 6. Operational Counters

Staff summaries return these backend-derived counters:

| Counter | Definition |
| --- | --- |
| `open` | JobCards assigned to the Staff user in `NEW`, `PLANNED`, or `IN_PROGRESS` |
| `waitingApproval` | assigned JobCards in `WAITING_APPROVAL` |
| `revisionRequested` | assigned JobCards in `REVISION_REQUESTED` |
| `completedThisMonth` | assigned JobCards approved into `COMPLETED` during the current calendar month |

The completed-month boundary uses the organization's timezone. V1 organizations default to `Europe/Istanbul`; the repository converts that calendar boundary to instants before filtering `manager_approved_at`. `CANCELLED` JobCards do not contribute to any counter. The frontend displays returned values and does not derive them from locally loaded JobCards.

## 7. API Contract

### Users `/api/users`

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| `GET` | `/` | Admin, Manager | list safe organization users |
| `POST` | `/` | Admin | create user and required/forbidden profile by role |
| `GET` | `/:userId` | Admin, Manager | read safe organization user detail |
| `PATCH` | `/:userId` | Admin | update name, permitted role, active state, and optional conversion profile |
| `POST` | `/:userId/reset-password` | Admin | set Admin-provided temporary password and revoke sessions |

Safe user responses contain identifiers, name, normalized email, role, active state, mandatory-change state, last login time, and timestamps. They never contain password hashes, sessions, tokens, or temporary passwords.

`PATCH /api/users/:userId` requires `expectedUpdatedAt`. The update succeeds only when the persisted timestamp matches, otherwise it returns `409 USER_VERSION_CONFLICT`. The response contains the new `updatedAt` value.

### Staff `/api/staff`

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| `GET` | `/` | Admin, Manager | list organization Staff profiles; active only by default |
| `GET` | `/me` | Staff | read own profile and counters |
| `GET` | `/:userId` | Admin, Manager, self | read scoped Staff profile and counters |
| `PATCH` | `/:userId` | Admin, Manager | update title, phone, region, manager, and notes |

`PATCH /api/staff/:userId` requires `expectedUpdatedAt` and returns `409 STAFF_PROFILE_VERSION_CONFLICT` on mismatch. Staff cannot edit profiles in this slice.

### Mandatory password guard

Authenticated requests made while `must_change_password = true` return `403 PASSWORD_CHANGE_REQUIRED`, except:

- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `POST /api/auth/logout`

The guard runs after session authentication and before domain authorization or handlers.

## 8. Error Contract

The API uses stable machine-readable codes and safe Turkish UI messages:

- `EMAIL_ALREADY_EXISTS`
- `STAFF_PROFILE_REQUIRED`
- `STAFF_PROFILE_NOT_ALLOWED`
- `MANAGER_NOT_ELIGIBLE`
- `STAFF_ROLE_CHANGE_NOT_SUPPORTED`
- `SELF_ROLE_CHANGE_FORBIDDEN`
- `SELF_DEACTIVATION_FORBIDDEN`
- `LAST_ACTIVE_ADMIN_REQUIRED`
- `USER_VERSION_CONFLICT`
- `STAFF_PROFILE_VERSION_CONFLICT`
- `PASSWORD_CHANGE_REQUIRED`

Cross-organization identifiers must not reveal record existence. They return the same not-found behavior as missing records. Validation errors identify the invalid field and correction without exposing password-policy internals beyond the documented length bounds.

Management CRUD does not use `processed_actions`. Database uniqueness, transactions, and optimistic concurrency prevent duplicate or stale writes. A repeated create with the same email returns `EMAIL_ALREADY_EXISTS`; it does not create a second user or profile.

## 9. Transaction Boundaries

- Staff creation: user and profile are inserted atomically.
- Admin/Manager-to-Staff conversion: role update and profile insertion are atomic.
- Deactivation: active-state update and all-session revocation are atomic.
- Password reset: password hash update, mandatory-change flag, and all-session revocation are atomic.
- Profile update: target profile, organization ownership, role, manager eligibility, and expected timestamp are validated within one transaction.
- Last-active-Admin protection locks or atomically checks the relevant organization Admin rows so concurrent requests cannot remove all active Admins.

Any failure rolls the complete operation back.

## 10. Frontend Design

### Admin

- Add a `Kullanıcılar` workspace section without introducing a router dependency.
- Use a structured responsive list rather than a compressed mobile table.
- Show name, email, role, active state, and assigned manager for Staff.
- The create form always asks for name, email, role, and temporary password.
- Selecting Staff reveals title, phone, region, manager, and notes; the Staff profile payload becomes required.
- User detail exposes only permitted role changes, active-state management, and password reset.
- Deactivation and password reset require an explicit confirmation step and announce their result.
- Temporary passwords are never displayed after submission.

### Manager

- Read the organization user list without edit controls.
- Read Staff profiles and update title, phone, region, manager, and notes.
- Never see controls for role, active state, or password reset.

### Staff

- Add `Profilim` with profile data and the four operational counters.
- Do not expose other-user or other-profile navigation.
- When `mustChangePassword` is true, replace the normal workspace with a mandatory password-change screen.
- After a successful password change, show a result message and require fresh login.

### Shared states and accessibility

- Provide loading, empty, forbidden, validation, network retry, and stale-version states.
- Associate every field with a visible label and every error with its field.
- On failed submit, focus the error summary or first invalid field.
- Preserve visible focus, logical keyboard order, native controls, non-color status text, and at least 44 by 44 CSS px interaction areas where applicable.
- Verify approximately 390 CSS px, 200 percent text size, supported 400 percent effective reflow, reduced motion, and screen-reader semantics.

## 11. Testing Strategy

Implementation follows red-green-refactor. Each behavior begins with a focused failing test.

### Backend

- Migration applies and enforces one profile per user.
- Staff creation requires a profile and rolls back both records on failure.
- Non-Staff creation rejects a profile.
- Manager assignment rejects inactive, wrong-role, or cross-organization users.
- Role transitions follow the approved matrix.
- Self-role change, self-deactivation, and final-active-Admin removal are rejected.
- Concurrent Admin removal cannot leave the organization without an active Admin.
- Deactivation and password reset revoke sessions transactionally.
- Forced-change users can reach only the three auth endpoints.
- Staff reads only self; Admin and Manager remain organization-scoped.
- Counter queries cover every status, month-boundary instants, and `Europe/Istanbul` conversion.
- Route tests cover safe response shapes, roles, validation, conflicts, and not-found concealment.

### Frontend

- Admin list, create, detail, role-conditioned form, confirmation, and reset flows.
- Manager read-only user view and editable Staff profile fields.
- Staff own profile and counter rendering.
- Mandatory password-change interception and fresh-login result.
- Loading, empty, validation, forbidden, retry, and conflict states.
- Accessibility contracts for labels, focus, touch targets, responsive reflow, and reduced motion.

### Live tracer

Use disposable PostgreSQL and the real HTTP/browser stack:

```text
migrate
→ development seed
→ Admin login
→ create Staff with profile and temporary password
→ Staff login
→ forced password change
→ fresh Staff login
→ own profile and counters
→ Manager login
→ profile read and update
→ Admin login
→ deactivate Staff
→ verify session revocation and login rejection
```

Playwright verifies the critical Admin, Manager, and Staff paths at a mobile viewport, keyboard operation, focus visibility, text enlargement/reflow, reduced motion, and semantic accessibility snapshots.

## 12. Completion Criteria

Slice 04 is complete only when:

- All approved role, profile, activation, and password invariants are enforced by backend tests.
- User/profile writes are transactional and stale writes are rejected.
- Staff counters come from persisted backend data using the organization timezone.
- Admin, Manager, and Staff can complete their respective browser flows without forbidden controls or data leakage.
- Automated server/web tests, production builds, and dependency audits pass.
- Disposable PostgreSQL and Playwright tracer checks pass and are recorded.
- API, schema, MVP slice, design, and operational documentation reflect the implemented behavior.
- Server and web Codebase Memory indexes are refreshed and the worktree is clean after slice commits.

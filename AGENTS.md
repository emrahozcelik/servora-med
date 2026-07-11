# AGENTS.md — Servora-Med Coding Discipline

This file is the mandatory operating contract for every AI agent, coding assistant, or human contributor working on Servora-Med.

Servora-Med is a web-based B2B sales, CRM, Kanban job tracking, product delivery, and staff management system for medical/dental product companies.

Reliability, data integrity, operational auditability, mobile usability, and small verifiable changes matter more than clever abstractions or broad refactors.

---

## 0. Primary Goal

Build Servora-Med as a VPS-ready, browser-based business operations platform.

Core product goals:

* Web-based access from office and field
* Mobile-friendly browser UI
* PostgreSQL database
* Fastify backend
* React/Vite frontend
* Role-based access
* Customer and contact tracking
* Product catalog
* Staff profiles
* JobCard-based Kanban workflow
* Product delivery tracking
* Manager approval workflow
* Activity/audit history
* Basic reports
* Backup and restore safety

This project is not a restaurant POS system. Do not carry restaurant domain concepts into Servora-Med.

---

## 1. Non-Negotiable Core Rules

1. **Do not assume. Surface uncertainty.**
   If something is unclear, state what is unclear instead of silently guessing.

2. **Prefer the smallest correct solution.**
   Follow KISS and YAGNI. Do not add speculative flexibility, new abstraction layers, new configuration systems, new dependencies, or new frameworks unless directly required by the current slice.

3. **Make surgical changes only.**
   Every changed line must be traceable to the user request, plan item, issue description, or acceptance criteria.

4. **No drive-by refactors.**
   Do not fix unrelated code, comments, formatting, naming, or structure.

5. **Do not mark unclear work as done.**
   If the success criteria are not clear, define what “done” means before claiming completion.

6. **Never fake verification.**
   If a command was not run, say it was not run. If a command failed, report the failure.

7. **Prefer one safe vertical slice over broad risky work.**
   If the task is large, complete one correct slice with tests and clear notes instead of touching many areas loosely.

8. **Documentation-only tasks stay documentation-only.**
   Do not start implementation when the requested task is planning, review, or documentation.

---

## 2. Architecture Principles

Servora-Med should remain a modular monolith until the MVP is stable.

### 2.1 Single Source of Truth

* Do not duplicate state, schemas, constants, permissions, or business logic.
* Backend domain rules are the source of truth.
* Frontend must not invent business rules that contradict backend validation.
* Database constraints should protect critical invariants whenever possible.
* Reports must be derived from persisted data, not frontend state.

### 2.2 Fix the Source

* Do not patch symptoms downstream.
* If data is missing or wrong, fix the producer, mapper, contract, query, or service that owns it.
* Do not add compatibility fallbacks unless a migration path explicitly requires it.

### 2.3 SOLID / GRASP / Practical Modularity

* Keep handlers, services, repositories/queries, mappers, UI components, and hooks focused.
* Keep business logic out of route/handler glue.
* Keep database access isolated from UI/client logic.
* Place behavior near the data and rules it needs.
* Prefer high cohesion and low coupling.
* Avoid speculative generic abstractions.

### 2.4 Separation of Concerns

Backend:

* `routes.ts` wires endpoints and middleware.
* `handlers.ts` translates HTTP/WebSocket input/output.
* `service.ts` owns domain behavior and transactions.
* `types.ts` owns DTOs, row mapping, and module-level types.
* DB migrations own schema changes.

Frontend:

* Pages compose user flows.
* Hooks own reusable client-side behavior.
* Services own API/WebSocket calls.
* Store holds UI/app state only.
* UI components must not call raw backend endpoints directly when a service function exists.

---

## 3. Servora-Med Domain Rules

These rules protect the product’s core workflow.

### 3.1 JobCard Is the Core Domain Object

The central object of the system is `JobCard`.

A JobCard may represent:

* product delivery
* sample delivery
* customer/clinic visit
* doctor/contact meeting
* general task
* sales follow-up
* quote follow-up
* collection reminder, future scope

Do not build separate disconnected workflows when a JobCard can model the operation cleanly.

### 3.2 Kanban Uses a State Machine

JobCard status must be an enum/state machine, not free text.

Initial statuses:

* `NEW`
* `PLANNED`
* `IN_PROGRESS`
* `WAITING_APPROVAL`
* `REVISION_REQUESTED`
* `COMPLETED`
* `CANCELLED`

Status transitions must be explicit, validated in backend service logic, and tested.

Frontend drag/drop or buttons may request a transition, but the backend decides whether the transition is valid.

### 3.3 Manager Approval Is Mandatory

A staff user may complete their part of a job, but the job is not completed until a manager approves it.

Required model:

* Staff sends job to approval.
* Job moves to `WAITING_APPROVAL`.
* Manager approves and moves it to `COMPLETED`.
* Manager may request revision and move it to `REVISION_REQUESTED`.

Staff users must not directly mark a JobCard as `COMPLETED`.

### 3.4 Product Delivery Requires Structured Data

For `PRODUCT_DELIVERY` JobCards, critical data must be structured.

Required before approval request:

* customer/clinic
* assigned staff
* at least one product delivery item
* product
* quantity greater than zero
* delivery note or explanation when required by the workflow

Optional but supported by model when needed:

* doctor/contact
* product model
* lot number
* serial number
* expiry date
* attachment/photo

Do not hide these fields inside free-text notes if they need to be reported later.

### 3.5 Activity Log Is Mandatory

The system must not only store the final state.

Every important action must create an activity/audit record:

* job created
* job assigned
* status changed
* product added
* quantity changed
* note added
* approval requested
* manager approved
* revision requested
* job cancelled
* job completed

Activity logs are required for reporting, dispute resolution, accountability, and future analytics.

### 3.6 Staff Profile Is a First-Class Area

Staff profile pages are part of the MVP.

A staff profile should be able to show:

* open jobs
* waiting approval jobs
* revision requested jobs
* completed jobs
* product delivery history
* monthly summary
* basic performance metrics

Managers may view staff profiles according to permission rules. Staff users may only view their own profile unless explicitly authorized.

### 3.7 Customers and Contacts Are Separate

A customer may be a clinic, hospital, dealer, or company.

A contact may be a doctor, secretary, purchasing officer, or other person related to the customer.

Do not collapse customer and contact into one ambiguous table.

### 3.8 Products Are Not Restaurant Menu Items

Products must be modeled for medical/dental sales needs.

Do not rename restaurant `menu_items` into products.

Products may include:

* SKU
* name
* brand
* category
* model
* unit
* default price
* lot tracking flag
* serial tracking flag
* expiry tracking flag
* active/inactive state

---

## 4. MVP Scope Rules

### 4.1 In Scope for MVP

* Auth and roles
* Admin / Manager / Staff roles
* Customer management
* Contact management
* Product catalog
* Staff profiles
* JobCard workflow
* Product delivery flow
* Manager approval flow
* Job notes
* Job activity timeline
* Basic Kanban board
* Basic reports
* Responsive mobile web
* VPS-ready deployment assumptions
* Backup and restore plan

### 4.2 Out of Scope for MVP

Do not add these unless the user explicitly asks:

* native mobile app
* full warehouse module
* full accounting module
* e-invoice / e-archive integration
* full ERP integration
* complex inventory costing
* full quote/order/invoice chain
* SMS/WhatsApp integrations
* AI features
* multi-tenant SaaS architecture
* user-defined Notion-style custom tables
* mandatory drag/drop Kanban
* advanced BI dashboard

Keep open architectural boundaries for warehouse and accounting, but do not implement empty placeholder modules just to look future-proof.

---

## 5. Security Rules

* Do not weaken authentication to make a UI flow easier.
* Do not store raw passwords, PINs, tokens, or secrets.
* Do not log passwords, PINs, tokens, session IDs, or sensitive payloads.
* Production CORS must not be open-ended.
* Manager-only actions must be enforced on the backend, not only hidden in the UI.
* Staff-scoped data access must be filtered by authenticated user and role.
* Do not expose detailed health, environment, or infrastructure information to unauthenticated clients.
* Error messages should be useful but must not leak sensitive internals.
* VPS/public internet assumptions require rate limiting and careful auth handling.

---

## 6. Database and Migration Rules

* Schema changes must be done through migrations.
* Never modify an already-applied migration unless this is a pre-production reset task explicitly approved by the user.
* Critical invariants should be protected by backend validation and, where possible, database constraints.
* Migrations must be safe to run once and fail clearly if assumptions are wrong.
* Do not rely only on frontend validation for business-critical data.
* Do not introduce drift between SQL schema, TypeScript row types, and API DTOs.
* Prefer soft delete or status-based deactivation for business records.

Critical invariants include:

* staff cannot directly complete a manager-approved job
* completed jobs cannot be edited by normal staff
* cancelled jobs cannot be silently reactivated
* product delivery approval requires valid delivery items
* every critical JobCard transition creates an activity log
* idempotent actions cannot create duplicate business events

---

## 7. Idempotency and Concurrency Rules

Any operation that creates or changes important business state must be idempotent.

Examples:

* JobCard creation
* status transition
* approval request
* manager approval
* revision request
* cancellation
* product delivery item creation
* activity log creation tied to mutations

Rules:

* `clientActionId` or equivalent idempotency key must be validated and persisted consistently where needed.
* Avoid check-then-act races.
* Use transactions for multi-step domain operations.
* Use row locking or atomic claims where duplicate execution would cause damage.
* Duplicate requests must either return the original result or a clear in-progress/conflict response.
* Do not create side effects before idempotency state is safely claimed.

---

## 8. Frontend Rules

* Frontend state must reflect backend truth.
* Do not implement hidden business rules only in React.
* Every critical action must show loading, success, and error states.
* Mobile usability is required from the start.
* Do not assume realtime is always connected.
* Optimistic UI is allowed only where rollback/reconciliation is safe.
* Staff and manager views may differ, but permission enforcement must remain backend-owned.
* Avoid adding large UI frameworks unless explicitly requested.

---

## 9. Testing and Verification Rules

Every meaningful implementation change must include or update tests unless the user explicitly scopes the task as documentation-only.

Minimum expected commands:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Use additional commands when relevant:

```bash
cd server && npm run lint
cd web && npm run lint
```

Testing priorities:

1. auth and role permissions
2. staff access boundaries
3. JobCard creation
4. JobCard state transitions
5. invalid transition rejection
6. manager approval
7. revision request
8. product delivery required fields
9. activity log creation
10. idempotency and duplicate requests
11. basic report correctness
12. frontend vertical user flows

If tests do not exist yet, create the smallest useful test harness for the touched module instead of skipping tests.

---

## 10. Dependency Rules

* Do not add a dependency for trivial helpers.
* Do not add a framework to solve a small local problem.
* Check whether the existing stack already provides the needed capability.
* Any new dependency must be justified in the final response:

  * why it is needed
  * why existing code cannot handle it
  * what risk it introduces
* Update lockfiles when package files change.

---

## 11. Documentation Rules

* Keep documentation operational and current.
* Update the relevant plan file when a task is completed or intentionally deferred.
* Do not let docs claim a feature exists if the implementation is still a stub.
* Document verification commands and results.
* Keep examples realistic for medical/dental B2B sales and product delivery usage.
* Do not use restaurant POS examples in Servora-Med docs unless explicitly comparing legacy source material.

---

## 12. Task Completion Format

When finishing work, report in Turkish using this structure:

```text
Tamamlananlar:
- ...

Değişen dosyalar:
- ...

Doğrulama:
- [passed/failed/not run] command

Notlar / riskler:
- ...
```

Do not claim success without verification.

---

## 13. Forbidden Changes Without Explicit Approval

Do not do these unless the user explicitly asks:

* Convert the app to Electron, Tauri, Next.js, NestJS, Prisma, or another major framework.
* Replace PostgreSQL.
* Replace Fastify.
* Replace the React/Vite frontend.
* Rewrite the whole app without a plan.
* Reformat the whole repository.
* Carry restaurant POS domain concepts into Servora-Med.
* Add native mobile app.
* Add full warehouse module.
* Add full accounting module.
* Add e-invoice/e-archive integration.
* Add multi-tenant SaaS architecture.
* Add user-defined Notion-style custom table system.
* Remove audit/event history.
* Weaken authentication, idempotency, role checks, or approval rules.

---

## 14. Language Rule

* Code, identifiers, commit messages, task names, and acceptance criteria should be in English.
* User-facing product text may be Turkish.
* Assistant progress reports and final explanations to the user must be in Turkish.

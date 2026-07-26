# Phase U1 browser evidence

All captures were produced from visual code commit
`2e353a461729b483668c36ae914a4ff580a8991b` with the committed synthetic
fixture in `web/scripts/phase-u-u1-evidence-fixture.tsx`. The fixture contains
only reserved `.test` addresses and synthetic people, customers, jobs and
identifiers. No real PII, credentials, password values, tokens, push endpoints
or production content are present.

The viewport column records the CSS viewport requested from Playwright. A
full-page PNG may be narrower by the browser scrollbar width.

| PNG | Route | Role | Capability | Viewport | Contract demonstrated | Overflow | Console | Network |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `staff-overview-390.png` | `/overview?role=staff` | Staff | Overview on | 390 × 844 | Staff KPIs, assigned work/notes, four-control mobile navigation | none | 0 application errors | 0 unexpected failures |
| `staff-overview-1024.png` | `/overview?role=staff` | Staff | Overview on | 1024 × 768 | Staff desktop workspace without management or admin data | none | 0 application errors | 0 unexpected failures |
| `staff-overview-empty-390.png` | `/overview?role=staff&empty=1` | Staff | Overview on | 390 × 844 | Separate recent-work and authorized-note empty states | none | 0 application errors | 0 unexpected failures |
| `staff-overview-error-390.png` | `/overview?role=staff&error=1` | Staff | Overview on | 390 × 844 | Safe error copy and retry action | none | 0 application errors | expected synthetic overview 503 only |
| `manager-overview-390.png` | `/overview?role=manager` | Manager | Overview on | 390 × 844 | Management KPIs, completion/control summary and mobile layout | none | 0 application errors | 0 unexpected failures |
| `manager-overview-1440.png` | `/overview?role=manager` | Manager | Overview on | 1440 × 900 | Desktop navigation, management trend, authorized recent work/notes | none | 0 application errors | 0 unexpected failures |
| `overview-disabled-jobs-390.png` | `/?role=staff&overview=off` | Staff | Overview off | 390 × 844 | Root fallback to Jobs, absent Overview navigation and no overview request | none | 0 application errors | 0 unexpected failures |
| `workspace-docs-1024.png` | `/docs?role=staff` | Staff | Overview on | 1024 × 768 | Typed workspace documentation remains independently reachable | none | 0 application errors | 0 unexpected failures |
| `help-center-390.png` | `/help?role=staff` | Staff | Overview on | 390 × 844 | Safe synthetic support information and mobile wrapping | none | 0 application errors | 0 unexpected failures |
| `settings-profile-390.png` | `/settings/profile?role=staff` | Staff | Overview on | 390 × 844 | Read-only initials profile and long identity wrapping | none | 0 application errors | 0 unexpected failures |
| `settings-security-1024.png` | `/settings/security?role=staff` | Staff | Overview on | 1024 × 768 | Existing password-change form with all three password fields empty | none | 0 application errors | 0 unexpected failures |
| `settings-notifications-390.png` | `/settings/notifications?role=staff` | Staff | Overview on | 390 × 844 | Current-device notification controls without endpoint or VAPID-key disclosure | none | 0 application errors | 0 unexpected failures |

Additional direct checks covered Staff and Manager at 390, 1024 and 1440 CSS
pixels; Admin management scope at 1024; Manager Docs, Help, Settings and mobile
drawer; keyboard Tab navigation with a visible 3 px focus outline; unclipped
heading bounds; and a 512 px effective viewport representing a 200% desktop
zoom layout. The capability-off root and direct `/overview` routes both resolved
once to `/jobs`; Docs, Help and Settings remained reachable; and the captured
request log contained no `/api/overview` request.

Chrome DevTools MCP independently repeated the Manager 1024 check. It reported
no console messages, no failed resource requests, no horizontal overflow, and
the expected management trend/control-queue content.

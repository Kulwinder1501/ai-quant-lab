# API architecture

The API follows a feature-first, layered TypeScript structure:

```text
src/
├── config/                       Runtime environment configuration
├── interfaces/
│   ├── cli/                      Command-line entry points
│   ├── http/
│   │   ├── app.ts                Express composition root only
│   │   ├── dependencies.ts       HTTP dependency factory
│   │   ├── common/               Shared middleware and query parsing
│   │   └── routes/               Cross-cutting routes such as health
│   └── scheduler/                Scheduled-job entry point
├── infrastructure/               PostgreSQL and external providers
└── modules/
    └── <feature>/
        ├── application/          Use cases and orchestration
        ├── domain/               Business rules and types
        ├── infrastructure/       Feature-specific adapters
        └── interfaces/http/      Express route/controller adapters
```

## Dependency direction

- Domain code has no Express or PostgreSQL dependency.
- Application services coordinate domain rules through repository interfaces.
- Infrastructure implements persistence and external-provider access.
- Feature HTTP adapters translate requests and responses, then call application services.
- `interfaces/http/app.ts` wires middleware and feature route registrars; endpoint logic does not belong there.

Only folders required by implemented capabilities are created. Authentication, Redis, queues, uploads, mail, and similar template folders should be added when those capabilities actually exist.

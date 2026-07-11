---
title: System Design Agent Team — Design Specification
status: approved-design
version: 1.0.0
date: 2026-07-11
language: English
primary_runtime: Codex
framework_model: Hybrid CLI-driven workflow engine
---

# System Design Agent Team — Design Specification

## 1. Executive Summary

`system-design-agent-team` is a Codex-first, approval-gated, END2END agent framework for designing, building, validating, releasing, and operating software systems. It supports:

- **Greenfield projects** starting from a business problem.
- **Existing-system projects** that must inspect the current repository, architecture, data, tests, deployment, and incidents before proposing changes.
- **Migration projects** that require current-state assessment, target-state architecture, data reconciliation, cutover, rollback, and legacy decommission controls.

The framework uses a **hybrid orchestration model**:

- A Lead Orchestrator manages workflow state, context, dispatch, review loops, and approvals.
- Each phase has a designated author and an independent reviewer.
- Conditional specialists are invoked when risk triggers apply.
- An Agent Council is convened only for material conflicts, high-cost decisions, or unresolved review loops.
- Human approval is mandatory at critical gates, especially scope, requirements, UX direction, technology stack, destructive migration, release, and production deployment.

Version 1 is a **TypeScript CLI-driven workflow engine**. Markdown and YAML files committed to Git are the source of truth. SQLite is an optional disposable cache. A Python multi-agent runtime is deferred to a later version.

## 2. Goals and Non-Goals

### 2.1 Goals

The framework shall:

1. Convert business intent into traceable requirements, backlog, UX, architecture, implementation, test, release, and operations artifacts.
2. Enforce phase dependencies and approval gates through executable policy, not prompt wording alone.
3. Support author-reviewer separation and prevent self-approval.
4. Require evidence for implementation, testing, migration, security, and deployment claims.
5. Integrate required plugins and record verifiable invocation evidence.
6. Restrict agents to explicit read, write, command, and external-system scopes.
7. Preserve project memory, decisions, approvals, traceability, and audit history in Git.
8. Detect stale downstream artifacts when approved inputs change.
9. Support small, standard, enterprise, regulated, and custom project profiles.
10. Remain adaptable to future Codex changes and additional execution adapters.

### 2.2 Non-Goals for Version 1

Version 1 will not:

- Implement a persistent Python message bus or autonomous multi-project service.
- Reverse-engineer or copy third-party plugin internals.
- Bypass plugin access controls.
- Replace human business ownership or production authorization.
- Infer that a plugin was used merely because an agent claims it was used.
- Require every project to generate every possible artifact.
- Force a single technology stack, Git strategy, or deployment platform.
- Treat SQLite as authoritative storage.

## 3. Architectural Principles

1. **Git-backed truth:** Markdown and YAML project artifacts are authoritative.
2. **Default deny:** Agents receive the minimum permissions required for one bounded task.
3. **Explicit transitions:** Only the workflow engine may commit official state transitions.
4. **Independent review:** An artifact author cannot approve the artifact.
5. **Evidence over assertion:** Completion claims require reproducible evidence.
6. **Human control:** Irreversible, high-risk, or business-defining actions require human approval.
7. **Scoped context:** Each agent receives only current and relevant inputs.
8. **Stable contracts:** Core domain contracts are independent of a specific runtime adapter.
9. **No silent changes:** Approved content cannot change without impact analysis and reapproval where required.
10. **Rebuildable derived state:** Generated adapter files and SQLite cache can be recreated from authoritative files.
11. **Bounded agents:** Every agent has one clear purpose, defined inputs, defined outputs, and explicit prohibited actions.
12. **No hidden implementation:** Placeholders, fake implementations, silent fallbacks, and duplicate “V2/Fixed/Final” files are prohibited at review-ready states.

## 4. High-Level Architecture

```text
User / Product Sponsor
          │
          ▼
Lead Orchestrator
          │
          ├── Workflow Engine
          ├── Project Store
          ├── Artifact and Traceability Engine
          ├── Policy and Gate Evaluator
          ├── Plugin Registry
          ├── Context Packager
          └── Execution Adapter
                    │
                    ▼
                  Codex
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
     Phase Owner  Reviewer  Specialists / Council
```

The system is divided into four layers:

1. **Core Domain:** agents, roles, artifacts, IDs, policies, state machines, handovers, reviews, and approvals.
2. **Workflow Engine:** phase transitions, dependency checks, review loops, gates, stale propagation, and escalation.
3. **Execution Adapter:** runtime-specific dispatch, capability checks, permission setup, execution, cancellation, and result collection.
4. **Runtime:** Codex in Version 1, with future adapters for Claude Code, OpenCode, CI workers, and an optional Python multi-agent service.

## 5. Central Repository

Proposed repository:

```text
system-design-agent-team/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── cli/
│   ├── core/
│   ├── workflow-engine/
│   ├── artifact-validator/
│   ├── traceability/
│   ├── codex-adapter/
│   ├── plugin-registry/
│   ├── project-store/
│   ├── sqlite-cache/
│   └── testing-kit/
├── agents/
├── workflows/
├── schemas/
├── templates/
├── quality-gates/
├── docs/
└── tests/
```

### 5.1 Package Responsibilities

| Package | Responsibility |
|---|---|
| `core` | Domain types, IDs, contracts, policies, and shared errors |
| `workflow-engine` | Phase lifecycle, gates, reviews, approvals, escalation, and change control |
| `artifact-validator` | Syntax, schema, semantic, consistency, and gate-readiness validation |
| `traceability` | Trace graph, coverage, dependency impact, and stale detection |
| `codex-adapter` | Codex capability checks, dispatch preparation, execution, and result collection |
| `plugin-registry` | Plugin identity, skill capability, compatibility, fallback policy, and invocation evidence |
| `project-store` | Atomic Git-backed YAML/Markdown persistence and audit events |
| `sqlite-cache` | Optional disposable query and indexing cache |
| `cli` | User-facing commands and interactive/non-interactive workflows |
| `testing-kit` | Fixtures, fake adapters, temporary repositories, and workflow test helpers |

## 6. Project Installation

The CLI bootstraps the framework into a target repository:

```bash
npx @system-design-team/cli init
```

Project-owned structure:

```text
target-project/
├── AGENTS.md
├── .agent-team/
│   ├── project.yaml
│   ├── workflow-state.yaml
│   ├── approvals.yaml
│   ├── plugin-status.yaml
│   ├── framework-lock.yaml
│   ├── artifact-registry.yaml
│   ├── traceability.yaml
│   ├── glossary.yaml
│   ├── context/
│   ├── requirements/
│   ├── product/
│   ├── ux/
│   ├── architecture/
│   ├── implementation/
│   ├── testing/
│   ├── security/
│   ├── data/
│   ├── release/
│   ├── operations/
│   ├── reviews/
│   ├── decisions/
│   ├── changes/
│   ├── handovers/
│   ├── overrides/
│   └── cache/index.db
└── .codex/
    ├── AGENTS.md
    ├── agents/
    ├── skills/
    ├── workflows/
    ├── commands/
    └── generated/
```

`.codex/` is a framework-owned adapter surface, not an assumption that one immutable Codex internal format will exist forever. Generated files are derived, may be ignored by Git, and must not be edited directly.

## 7. Project Modes

### 7.1 Greenfield

```text
Project Intake
→ Business Discovery
→ Requirements
→ Product Planning
→ UX Design
→ Solution Architecture
→ Implementation Planning
→ Incremental Development
→ QA and Security Verification
→ Release Readiness
→ Deployment
→ Operational Validation
→ Post-release Review
```

### 7.2 Existing System

```text
Repository Discovery
→ Current-System Analysis
→ Change Request Analysis
→ Impact Analysis
→ Updated Requirements
→ UX and Architecture Delta
→ Implementation
→ Regression and Security Testing
→ Release
```

Mandatory discovery areas are scoped to the requested change and include relevant source, runtime, architecture, database, integrations, authorization, tests, CI/CD, deployment, incidents, and technical debt. The framework must not treat an existing system as greenfield or propose an unapproved rewrite.

### 7.3 Migration

```text
Legacy Assessment
→ Business Continuity Analysis
→ Target-State Definition
→ Data Mapping and Reconciliation Design
→ Transition Architecture
→ Migration Waves
→ Parallel Validation
→ Cutover Readiness
→ Human Cutover Approval
→ Cutover
→ Post-migration Reconciliation
→ Separate Legacy Decommission Approval
```

Migration requires source/target inventory, dependency mapping, downtime budget, coexistence plan, rollback criteria, data-loss tolerance, reconciliation rules, cutover checklist, and decommission controls.

## 8. Agent Hierarchy

```text
User / Product Sponsor
          │
          ▼
Lead Orchestrator
          │
          ├── Phase Owner
          ├── Independent Reviewer
          ├── Conditional Specialists
          └── Agent Council
```

### 8.1 Lead Orchestrator

Responsibilities:

- Detect project mode and profile.
- Select the workflow.
- Resolve required plugins and skills.
- Prepare scoped context packages.
- Dispatch authors and reviewers.
- Track issues, risks, approvals, and state.
- Enforce phase entry and exit conditions.
- Trigger review and revision loops.
- Convene Agent Council when escalation rules apply.
- Create phase handovers.
- Report progress, blockers, and decisions requiring human authority.

Prohibited:

- Self-approving artifacts.
- Selecting the final technology stack without the Architecture Gate decision.
- Deploying production without explicit approval.
- Rewriting approved decisions silently.
- Marking a phase complete without evidence.

Required plugin: `superpowers`, including `brainstorming`, `writing-plans`, and `verification-before-completion` where applicable.

### 8.2 Business / Customer Proxy

Produces business context, stakeholder perspective, problem statement, goals, constraints, expected outcomes, assumptions, and success criteria. It must not invent unstated requirements; unconfirmed statements remain assumptions.

### 8.3 Business Analyst

Produces:

- BRD
- SRS
- Functional and non-functional requirements
- Use-case catalogue
- Business-rule catalogue
- Permission matrix
- Requirement traceability
- Domain glossary
- Assumption and open-question log

Required plugin: `superpowers`, especially `brainstorming` during discovery and requirement clarification.

### 8.4 Requirements Reviewer

Independently checks completeness, consistency, testability, actors, exception flows, permissions, rationale, acceptance criteria, traceability, and hidden assumptions. Verdicts are `approved`, `approved_with_conditions`, `revision_required`, or `blocked`.

### 8.5 Product Owner

Produces product vision, scope, MVP, epics, stories, acceptance criteria, prioritized backlog, roadmap, and out-of-scope register. The main prioritization method is selected per project from MoSCoW, RICE, WSJF, value-versus-effort, risk-first, or dependency-first.

Required plugin: `superpowers` for structured product decomposition and planning.

### 8.6 Project Manager

Produces delivery plan, milestones, work breakdown, dependency map, critical path, risk register, issue register, decision log, change log, and release plan.

Required plugin: `superpowers`, especially `writing-plans`.

### 8.7 UI/UX Designer

Produces personas, journeys, information architecture, task flows, screen inventory, wireframe specification, interaction specification, UI state matrix, responsive behavior, accessibility requirements, design-system rules, and developer handoff.

Required plugin: `ux-design`. Default fallback policy: `block`.

Every screen and interaction must trace to an approved use case or story.

### 8.8 UX Reviewer

Reviews usability, consistency, task efficiency, error recovery, empty/loading/error states, validation, responsive behavior, and accessibility. Before G4, BA checks requirement consistency and the Architect checks feasibility without overriding UX for implementation convenience.

Required plugin: `ux-design`.

### 8.9 System Analyst

Produces system context, boundary, module catalogue, functional decomposition, system use cases, logical data flow, sequence and state specifications, integration requirements, permission model, and logical data model.

Required plugin: `systems-architecture`.

### 8.10 Solution Architect

Produces architecture options, technology-stack evaluation, architecture overview, component and deployment models, API/event/data/security/observability designs, scalability and resilience strategies, migration strategy, risks, and ADRs.

Required plugin: `systems-architecture`. Default fallback policy: `block`.

Technology selection follows controlled recommendation: the agent proposes two or three viable options with trade-offs, cost, maintainability, security, hiring availability, operational complexity, vendor lock-in, and reversal strategy. The user selects the final stack at G5.

### 8.11 Architecture Reviewer

Independently reviews requirement coverage, boundaries, overengineering, failure modes, availability, data consistency, security boundaries, operability, migration, rollback, team capability, cost, and lock-in.

Required plugin: `systems-architecture`.

### 8.12 Developer Lead and Developer

Responsibilities:

- Read approved requirements, UX, architecture, tests, code, and configuration before modification.
- Plan vertical slices and bounded changes.
- Preserve project architecture and conventions.
- Prefer modifying existing implementation to creating parallel duplicates.
- Use TDD where applicable.
- Add or update automated tests.
- Record implementation evidence and limitations.
- Update contracts and documentation when behavior changes.

Required plugins: `code-craftsmanship` and `superpowers`, including `test-driven-development` and `verification-before-completion` where applicable.

Prohibited:

- Coding before G6.
- Changing approved requirements silently.
- Disabling failing tests to claim success.
- Leaving fake implementations or unresolved placeholders.
- Unrelated refactoring.
- Creating arbitrary `New`, `V2`, `Fixed`, or `Final` duplicates.

### 8.13 Code Reviewer

Reviews acceptance criteria, architecture conformance, duplication, side effects, error handling, security, logging, tests, migrations, compatibility, and performance. It must be independent of the implementation execution.

Required plugin: `code-craftsmanship`.

### 8.14 QA / Tester

Produces test strategy, test plan, cases, traceability, regression suite, defects, evidence, summary, and release recommendation. It covers positive, negative, boundary, authorization, integration, migration, regression, usability, and recovery scenarios.

Required plugins: `code-craftsmanship` and `superpowers`, including `systematic-debugging` and `verification-before-completion`.

QA cannot mark a result passed based on Developer statements; execution evidence is required.

### 8.15 DevOps

Produces CI/CD design, environment matrix, infrastructure configuration, secret-management plan, deployment and rollback plans, health checks, observability, alert catalogue, backup/restore, deployment runbook, and operations runbook.

Required plugins: `systems-architecture` and `superpowers` verification skills.

Production access is not granted by default.

### 8.16 Security Reviewer

Triggered by authentication, authorization, sensitive data, payment, public APIs, file uploads, admin functions, external integrations, secrets, multi-tenancy, production infrastructure, or regulatory requirements.

Produces threat model, security requirements, abuse cases, findings, security tests, residual-risk register, and release verdict.

Required capabilities: security-review capability when installed; `systems-architecture` is required for security architecture review. A missing mandatory security capability blocks the relevant gate unless an explicit degraded-mode exception is approved by the correct risk owner.

### 8.17 Data / Database Reviewer

Triggered by persistent data, migration, reporting, analytics, finance, inventory, synchronization, high-volume transactions, or audit requirements.

Produces data-model review, data-quality rules, migration review, retention and ownership policy, backup-validation plan, data risks, and database release verdict.

Required plugin: `systems-architecture`, with database-specific capability when available.

### 8.18 Documentation Reviewer

Checks terminology, traceability, stale content, missing artifacts, contradictions across requirements/backlog/UX/architecture/API/data/tests/release/runbooks, and unresolved placeholders.

### 8.19 Operations Reviewer

Performs post-deployment verification, monitoring validation, alert routing, log and backup checks, SLO baseline, incident-readiness review, post-release review, and improvement backlog.

## 9. Small-Project Role Consolidation

Small projects may consolidate:

- BA + Product Owner
- System Analyst + Solution Architect
- Developer Lead + Developer
- QA Lead + Tester
- DevOps + Operations Reviewer

Two invariants remain mandatory:

1. The author and final reviewer are independent executions.
2. No agent approves its own artifact.

## 10. Agent Council

The Council is exceptional, not default. It is triggered by:

- Material conflict between agents.
- A high-cost or difficult-to-reverse decision.
- Multiple credible architecture options.
- Security-versus-business conflict.
- Migration risks involving data loss or downtime.
- Failure to reach an acceptable result after the configured revision limit.

Process:

```text
Problem framing
→ Independent assessments submitted without seeing other positions
→ Conflict identification
→ Evidence review
→ Option comparison
→ Recommendation
→ Minority opinion
→ Human decision when required
```

Required output:

- Decision context
- Options considered
- Evaluation criteria
- Arguments and evidence
- Trade-offs
- Risks and mitigations
- Minority opinion
- Recommendation
- Required human decision

Default maximum: two council rounds.

## 11. Standard Handover Contract

```yaml
handover:
  from_agent: business-analyst
  to_agent: product-owner
  phase: requirements
  objective:
    summary: Convert approved requirements into product scope.
  approved_inputs:
    - BRD@3
    - SRS@5
    - TRACEABILITY@2
  decisions:
    - id: DEC-REQ-001
      summary: Guest access is included in MVP.
  assumptions:
    - id: ASM-004
      statement: Initial launch supports one region only.
      status: confirmed
  unresolved_items: []
  constraints:
    - Corporate SSO is mandatory.
  risks:
    - id: RISK-012
      description: SSO integration documentation is incomplete.
  expected_outputs:
    - PRODUCT-VISION
    - PRODUCT-BACKLOG
    - RELEASE-ROADMAP
  acceptance_conditions:
    - Every story links to at least one approved requirement.
```

If an agent discovers an out-of-bound issue, it must raise the issue, identify the owner, freeze dependent decisions, request resolution, update the decision log, and resume only after the issue is resolved or explicitly accepted.

## 12. Workflow Definition

Workflow files are machine-readable YAML and declare:

- Phase owner
- Independent reviewer
- Required inputs and outputs
- Required plugins and skills
- Conditional specialists
- Validation schema
- Entry and exit conditions
- Approval policy
- Retry policy
- Escalation policy

Example:

```yaml
id: greenfield-standard
version: 1.0.0
mode: greenfield
phases:
  - id: intake
    owner: lead-orchestrator
    reviewer: documentation-reviewer
    gate: G0
  - id: requirements
    owner: business-analyst
    reviewer: requirements-reviewer
    gate: G2
  - id: product
    owner: product-owner
    reviewer: requirements-reviewer
    gate: G3
  - id: ux
    owner: ux-designer
    reviewer: ux-reviewer
    gate: G4
  - id: architecture
    owner: solution-architect
    reviewer: architecture-reviewer
    gate: G5
```

## 13. Phase State Machine

```text
not_started
    ↓
ready
    ↓
in_progress
    ↓
artifact_validation
    ↓
under_review
    ↓
revision_required ────┐
    ↑                  │
    └──────────────────┘
    ↓
awaiting_approval
    ↓
approved
    ↓
handed_over
```

Exceptional states:

- `blocked`
- `failed`
- `cancelled`
- `superseded`

Rules:

- `ready` requires all phase dependencies.
- `artifact_validation` verifies existence, schema, prohibited placeholders, required sections, and references.
- `under_review` uses an independent reviewer execution.
- `approved` requires a valid approval record when the gate is human-controlled.
- `handed_over` requires a valid handover package.
- An agent may propose but cannot directly commit its own official transition.

## 14. Approval Gates

| Gate | Purpose |
|---|---|
| G0 | Project intake and mode/profile approval |
| G1 | Business problem, goals, stakeholders, scope, and success metrics |
| G2 | BRD, SRS, use cases, rules, permissions, NFRs, and acceptance criteria |
| G3 | MVP, backlog, priorities, roadmap, dependencies, and out-of-scope |
| G4 | User flows, screens, interactions, states, accessibility, and UX handoff |
| G5 | Architecture option, technology stack, data, security, integration, operations, and risks |
| G6 | Vertical slices, implementation tasks, dependencies, tests, migration, rollback, and DoD |
| G7 | Release candidate, test evidence, defects, security, data, documentation, and reproducibility |
| G8 | Production window, owner, backup, rollback, monitoring, communication, and explicit authorization |
| G9 | Health, user journeys, integrity, monitoring, incident readiness, and business acceptance |

Human approval is always mandatory for final business scope, final requirements, UX direction, final technology stack, destructive migration, production deployment, and post-release business acceptance. Other gates may be configured as human-required based on the selected profile; the standard profile defaults to human approval for G0 through G9.

## 15. Approval Records

```yaml
approval:
  id: APR-G5-20260711-001
  project: example-project
  gate: G5
  artifact_versions:
    ARCHITECTURE-OVERVIEW: 3
    TECHNOLOGY-EVALUATION: 2
    SECURITY-ARCHITECTURE: 1
  decision: approved
  approved_by:
    type: human
    identifier: project-owner
  conditions:
    - id: COND-G5-001
      statement: Complete load testing before G7.
      owner: qa-lead
      required_before_gate: G7
      status: open
  timestamp: 2026-07-11T18:30:00+07:00
  integrity_hash: sha256:example
  git_commit: example-commit
```

Decision values:

- `approved`
- `approved_with_conditions`
- `rejected`
- `revoked`
- `expired`

Conditional approvals create tracked actions that block later gates when overdue.

## 16. Review Model and Revision Loops

```yaml
review:
  id: REV-ARCH-003
  artifact: ARCHITECTURE-OVERVIEW@3
  author: solution-architect
  reviewer: architecture-reviewer
  verdict: revision_required
  findings:
    - id: FIND-001
      severity: blocker
      category: availability
      description: Database failover strategy is missing.
      required_action: Define recovery topology and RTO/RPO.
```

Severities:

- `blocker`
- `critical`
- `major`
- `minor`
- `suggestion`

`blocker` and `critical` prevent approval. `major` requires correction or an approved exception. `minor` may be deferred. `suggestion` is non-blocking.

Default maximum revision rounds: three. After the limit:

```text
Freeze phase
→ Escalate to Lead Orchestrator
→ Convene Agent Council
→ Produce decision brief
→ Request human decision
```

## 17. Change Control

Approved artifacts cannot change silently.

```yaml
change_request:
  id: CR-017
  requested_by: product-owner
  affected_artifacts:
    - SRS
    - PRODUCT-BACKLOG
    - API-STRATEGY
  reason: Add guest collaboration to MVP.
  impact:
    scope: high
    architecture: medium
    security: high
    schedule: high
  required_reapprovals:
    - G2
    - G3
    - G5
```

Impact propagation:

```text
Approved input changes
→ Identify downstream dependencies
→ Mark affected artifacts stale or review-required
→ Reopen only necessary phases
→ Re-run validation and review
→ Request required reapprovals
```

Dependency types:

- `hard_dependency`: mark stale
- `soft_dependency`: warning
- `reference_only`: no automatic state change
- `derived_from`: regenerate or review

## 18. Artifact System

Supported formats:

- Markdown for narrative documents
- YAML for structured state and domain records
- JSON for generated reports and integrations
- Mermaid for text diagrams
- SQL for database contracts and migrations
- OpenAPI for HTTP contracts
- AsyncAPI for event contracts

Every artifact has:

- Stable ID
- Version
- Status
- Owner
- Reviewer
- Dependencies
- Consumers
- Gate
- Checksum
- Git commit reference where approved

Artifact statuses:

- `draft`
- `in_review`
- `revision_required`
- `approved`
- `approved_with_conditions`
- `stale`
- `superseded`
- `archived`
- `rejected`

## 19. Canonical Artifact Structure

```text
.agent-team/
├── project.yaml
├── workflow-state.yaml
├── approvals.yaml
├── plugin-status.yaml
├── framework-lock.yaml
├── artifact-registry.yaml
├── traceability.yaml
├── glossary.yaml
├── context/
│   ├── project-charter.md
│   ├── stakeholder-map.yaml
│   ├── assumptions.yaml
│   ├── constraints.yaml
│   ├── evidence-register.yaml
│   └── repository-assessment.md
├── requirements/
│   ├── brd.md
│   ├── srs.md
│   ├── requirements.yaml
│   ├── use-cases/
│   ├── business-rules.yaml
│   ├── permission-matrix.yaml
│   ├── non-functional-requirements.yaml
│   └── open-questions.yaml
├── product/
│   ├── product-vision.md
│   ├── scope.yaml
│   ├── epics.yaml
│   ├── backlog.yaml
│   ├── release-roadmap.md
│   ├── definition-of-ready.md
│   └── definition-of-done.md
├── ux/
│   ├── personas/
│   ├── journeys/
│   ├── information-architecture.md
│   ├── user-flows/
│   ├── screen-inventory.yaml
│   ├── interaction-specification.md
│   ├── ui-state-matrix.yaml
│   ├── accessibility-requirements.md
│   └── developer-handoff.md
├── architecture/
│   ├── architecture-overview.md
│   ├── system-context.md
│   ├── component-model.md
│   ├── deployment-model.md
│   ├── technology-evaluation.md
│   ├── api/
│   ├── events/
│   ├── data/
│   ├── security/
│   ├── observability/
│   ├── migration/
│   ├── adrs/
│   └── risks.yaml
├── implementation/
├── testing/
├── security/
├── data/
├── release/
├── operations/
├── reviews/
├── decisions/
├── changes/
├── handovers/
├── overrides/
└── cache/index.db
```

Profiles generate only required directories and artifacts.

## 20. Artifact Registry and Metadata

```yaml
artifacts:
  - id: BRD
    path: requirements/brd.md
    type: business_requirements
    version: 3
    status: approved
    owner: business-analyst
    reviewer: requirements-reviewer
    dependencies:
      - PROJECT-CHARTER@2
      - STAKEHOLDER-MAP@1
    consumers:
      - SRS
      - PRODUCT-SCOPE
      - TRACEABILITY
    required_gate: G2
    checksum: sha256:example
```

Markdown artifacts use YAML front matter:

```yaml
---
artifact_id: ARCHITECTURE-OVERVIEW
version: 4
status: in_review
owner: solution-architect
reviewer: architecture-reviewer
workflow_phase: architecture
required_gate: G5
dependencies:
  - SRS@5
  - UX-HANDOFF@2
  - NFR@3
related_decisions:
  - ADR-001
  - ADR-004
last_updated: 2026-07-11T18:45:00+07:00
---
```

The registry and artifact metadata must agree. File names alone do not define status.

## 21. Requirements and Traceability

Requirement example:

```yaml
requirements:
  - id: FR-AUTH-001
    type: functional
    title: User login with corporate SSO
    statement: The system shall allow an authorized employee to authenticate using the corporate SSO provider.
    rationale: Reduce account duplication and centralize access control.
    source:
      stakeholder: IT security manager
      evidence: INTERVIEW-004
    priority: must
    status: approved
    actors:
      - employee
    acceptance_criteria:
      - id: AC-FR-AUTH-001-01
        given: The employee has an active corporate account.
        when: The employee selects Sign in.
        then: The employee is redirected to the configured SSO provider.
```

IDs are stable and never reused. Removed requirements are `superseded` or `rejected`.

Traceability chain:

```text
Business Goal
→ Business Requirement
→ Functional / Non-functional Requirement
→ Use Case
→ Epic
→ User Story
→ UX Flow / Screen
→ Architecture Component
→ Implementation Task
→ Code Change
→ Test Case
→ Release Evidence
```

The engine detects orphan goals, unsourced requirements, stories without requirements, UX screens without use cases, unjustified architecture components, unapproved implementation work, requirements without tests, tests linked to superseded requirements, and release claims without current evidence.

Coverage metrics include acceptance coverage, story traceability, requirement-test coverage, criticality, negative-path coverage, authorization coverage, failure scenarios, data integrity, and migration risk. A high score never auto-approves a gate.

## 22. Project Memory

### 22.1 Stable Context

Business domain, organizational constraints, supported regions, compliance, legacy technology, team capability, and operational environment.

### 22.2 Decisions

Business scope, prioritization, architecture, technology, security exceptions, migration choices, and release decisions.

### 22.3 Working Memory

Open questions, blockers, pending reviews, pending approvals, and draft assumptions.

### 22.4 Evidence Memory

Repository files, database schema, interviews, documents, screenshots, logs, incidents, API responses, and test outputs.

### 22.5 Historical Memory

Superseded requirements, rejected options, closed risks, prior releases, and deprecated interfaces.

Historical data is retrieved only when relevant; it is not injected into every prompt.

## 23. Evidence and Assumptions

Evidence records include identity, type, location/reference, collector, time, summary, reliability, freshness, and sensitivity. Reliability values are `confirmed`, `high`, `medium`, `low`, and `unverified`.

Assumptions have owner, status, validation method, impact if false, and required gate. Status values are `proposed`, `pending_validation`, `confirmed`, `rejected`, `expired`, and `superseded`. High-impact assumptions cannot remain unresolved beyond their required gate.

Agents classify statements as:

- Confirmed fact
- Evidence-backed inference
- Assumption
- Recommendation
- Open question
- Unknown

An assumption cannot be handed over as a fact.

## 24. Validation

Validation levels:

1. Syntax
2. Schema
3. Semantic
4. Cross-artifact consistency
5. Gate readiness

Examples of semantic checks:

- A requirement describes one testable behavior.
- Acceptance criteria contain specific expected results.
- NFRs contain metrics and load conditions.
- Stories identify actor, need, and value.
- ADRs contain an actual decision.
- Test cases contain expected outcomes.
- Rollback plans define triggers.
- Runbooks include prerequisites and verification.

Prohibited in review-ready artifacts:

- `TBD`
- `TODO`
- “To be defined later”
- Lorem ipsum
- Placeholder architecture
- Sample requirements not removed
- Fake test evidence
- Silent fallback behavior

Drafts may temporarily contain explicit open questions tracked in structured logs, but cannot enter review with hidden placeholders.

## 25. Artifact Locking and Freshness

During review, an artifact is locked against author modification. To revise:

```text
Pause review
→ Return to revision_required
→ Increment version
→ Apply changes
→ Resume review
```

When a dependency changes, the engine applies dependency-specific staleness rules and records the impacted versions. Developers are blocked from using stale approved inputs.

## 26. Plugin Integration

Canonical registry:

```yaml
plugins:
  superpowers:
    uri: plugin://superpowers@openai-curated-remote
  code-craftsmanship:
    uri: plugin://code-craftsmanship@wondelai-skills
  systems-architecture:
    uri: plugin://systems-architecture@wondelai-skills
  ux-design:
    uri: plugin://ux-design@wondelai-skills
```

Agent manifests declare:

- Plugin URI
- Required skills/capabilities
- Compatibility requirements
- Fallback policy

Status values:

- `available`
- `unavailable`
- `disabled_by_policy`
- `installed_but_incompatible`
- `skill_missing`
- `verification_failed`
- `unknown`

`unknown` is not treated as available.

Fallback modes:

- `block`
- `request_user_action`
- `allow_with_approval`
- `optional`

Required plugin invocation evidence contains execution ID, agent, plugin URI, requested skill, status, timestamps, input/output digests, and adapter reference. It never stores private chain-of-thought or secret values.

When the runtime cannot produce verifiable invocation evidence, strict mode records `verification_failed` or `unverified` and blocks the phase. A degraded-mode exception must explicitly identify limitations and receive appropriate human approval.

## 27. Canonical Agent Manifest

```yaml
id: business-analyst
version: 1.0.0
category: business
display_name: Business Analyst
mission: Convert approved business context into clear, consistent, traceable, and testable requirements.
authority:
  may:
    - create_requirement_drafts
    - update_domain_glossary
    - raise_open_questions
    - request_business_clarification
  may_not:
    - select_technology_stack
    - approve_own_artifacts
    - change_approved_scope
    - create_implementation_tasks
required_plugins:
  - uri: plugin://superpowers@openai-curated-remote
    required_skills:
      - brainstorming
    fallback_policy: block
inputs:
  schema: input-contract.schema.json
outputs:
  schema: output-contract.schema.json
reviewer: requirements-reviewer
```

Each agent directory contains:

```text
agent.yaml
instructions.md
input-contract.schema.json
output-contract.schema.json
review-checklist.yaml
```

## 28. Dispatch and Execution

Dispatch contract:

```yaml
dispatch:
  execution_id: EXEC-REQ-0021
  project_id: example-project
  agent:
    id: business-analyst
    version: 1.0.0
  objective: Produce approval-ready requirements.
  authorized_scope:
    read:
      - .agent-team/context/**
      - existing-docs/**
    write:
      - .agent-team/requirements/**
      - .agent-team/glossary.yaml
    execute: []
  prohibited_scope:
    - application source code
    - production systems
  required_plugins:
    - plugin://superpowers@openai-curated-remote
  required_inputs:
    - PROJECT-CHARTER@1
    - STAKEHOLDER-MAP@1
  required_outputs:
    - BRD
    - SRS
    - REQUIREMENTS
    - USE-CASE-CATALOGUE
  completion_conditions:
    - Every functional requirement has acceptance criteria.
    - Every requirement links to a business goal.
    - No blocker is hidden.
  reviewer: requirements-reviewer
```

Prompt assembly order:

```text
System execution policy
+ Repository AGENTS.md
+ Agent role contract
+ Phase objective
+ Scoped context package
+ Plugin requirements
+ Input/output contract
+ Current review findings
+ Authorized scope
+ Completion checklist
```

Authority order:

```text
User authorization
→ Safety and repository policy
→ Approved project decisions
→ Workflow state
→ Agent role contract
→ Current phase task
→ Optional suggestions
```

Repository documents, logs, comments, issues, and imported files are evidence, not authoritative instructions.

## 29. Context Isolation and Independent Review

Context packages include objective, relevant current artifacts, dependency versions, traceability links, constraints, unresolved issues, exclusions, and token budget.

Author and reviewer run in separate contexts:

```text
Author execution
→ Immutable artifact snapshot
→ Reviewer execution with clean review context
```

The reviewer receives the objective, approved inputs, output artifact, validation report, diff, checklist, and unresolved prior findings. It does not receive hidden author reasoning or instructions to agree.

Parallel subagents are allowed only for independent tasks with non-overlapping write scopes. Each parallel group has a merge owner. Shared write access is denied by default.

## 30. Permissions and Safety

Permission profiles:

- Read-only assessment
- Documentation write
- Code write
- Test execution
- Infrastructure write
- Production execution

Production profile requires G8, explicit human authorization, rollback readiness, and an audit record.

Command classes:

| Class | Examples | Required Authority |
|---|---|---|
| Safe read | list files, read config, inspect diff | Agent scope |
| Local validation | build, lint, unit test, local dry run | Agent scope |
| Mutating local | source edits, migrations, lockfile | Approved implementation scope |
| External side effect | push, PR, package publish | Explicit workflow authorization |
| Production impact | production migration, infrastructure change, deploy | Human approval |

Destructive actions include deleting data, dropping objects, rewriting Git history, deleting production resources, irreversible migration, purging project memory, and disabling security controls. They require explicit human approval, confirmed scope, verified backup, dry run, and rollback or documented compensating controls.

## 31. Security and Governance

Security model:

```text
Default deny
→ Least privilege
→ Explicit scope
→ Evidence-based execution
→ Human approval for irreversible actions
```

Data classifications:

- Public
- Internal
- Confidential
- Restricted

The framework can raise but not automatically lower classification.

Raw passwords, tokens, API keys, private keys, production connection strings, cookies, personal-data dumps, and unredacted confidential logs are prohibited in artifacts. They are represented by external secret references.

Secret scans run before context packaging, persistence, commit, PR, and release candidate approval.

Third-party dependencies and plugins are checked for identity, allowed publisher, integrity, compatibility, lockfile consistency, suspicious installation behavior, and known risk where tooling is available.

Separation of duties applies to requirements, architecture, code, migration, tests, security residual risk, release, and production deployment.

Policy is expressed as code:

```yaml
policies:
  production_deployment:
    require:
      - gate:G8:approved
      - security_verdict:approved
      - test_verdict:approved
      - rollback_plan:current
      - backup_verification:passed
  architecture_approval:
    require:
      - independent_review
      - technology_options:minimum_2
      - security_review_if_triggered
```

Exceptions require owner, rationale, risk, compensating controls, approval, expiry, and a review gate. Critical risk cannot be waived indefinitely.

## 32. Reliability and State Integrity

Requirements:

- Atomic state writes
- Optimistic locking
- Idempotent mutating operations
- Append-only audit events
- Recoverable checkpoints
- Rebuildable cache
- Conflict detection
- No silent artifact or approval loss

Atomic update:

```text
Read current state
→ Validate expected version
→ Build proposed state
→ Validate transition
→ Write temporary file
→ Atomic replace
→ Append audit event
```

The global state contains a monotonically increasing `state_version`. Concurrent writers using an old version fail rather than overwrite newer state.

Mutating commands accept an operation ID. Repeating the same operation returns the prior result without duplicate approval, handover, review, or audit events.

Crash recovery must leave either the old transaction fully valid or the new transaction fully committed. Partial artifacts are preserved as incomplete evidence and never promoted automatically.

## 33. Audit Trail

Audit events include:

- Initialization and adoption
- Configuration changes
- Dispatch and cancellation
- Plugin invocation
- File and state mutation
- Commands run
- Review verdicts
- Approval creation, revocation, and expiry
- Change requests
- Production authorization and deployment
- Upgrade, eject, uninstall, and purge

Records identify actor, agent definition version, adapter, permission profile, artifact versions, authorization source, timestamps, and result. Private chain-of-thought is never stored.

## 34. Bootstrap CLI

Package:

```text
@system-design-team/cli
```

Executable:

```text
system-design-team
```

Requirements:

- Node.js 20 or newer
- Git
- Codex environment for Codex execution
- Required plugins for selected phases

Initialization:

```text
Detect repository
→ Inspect existing installation
→ Ask project mode and profile
→ Detect plugins
→ Generate configuration preview
→ Bootstrap files
→ Validate installation
→ Create Git-safe initial state
```

Non-interactive example:

```bash
system-design-team init \
  --mode existing-system \
  --profile standard \
  --language en \
  --cache sqlite \
  --codex \
  --yes
```

English is the canonical artifact and agent-to-agent language. User input may be another language; intake normalizes it to English while preserving domain terms in the glossary.

## 35. Project Profiles

### 35.1 Small

For low-risk internal tools and small teams. Uses role consolidation and minimum artifact set while retaining reviewer independence, evidence, security controls, and production approval.

### 35.2 Standard

Default for business systems. Includes full requirements, product, UX, architecture options, conditional specialists, implementation planning, QA traceability, release, and operations.

### 35.3 Enterprise

Adds formal traceability, architecture council, data governance, performance engineering, disaster recovery, strict change control, multi-environment approval, and operational acceptance.

### 35.4 Regulated

Adds formal evidence, mandatory security/data review, approval identity, audit retention, validation reports, data classification, and compliance mapping.

### 35.5 Custom

Extends a base profile with capabilities and safe overrides. It cannot disable self-approval prohibition, production approval, secret protection, evidence requirements, reviewer independence, or a mandatory risk-triggered security gate.

## 36. Configuration

Precedence:

```text
Framework defaults
→ Project profile
→ Project configuration
→ Environment configuration
→ Explicit command arguments
```

Safety invariants cannot be overridden by CLI flags.

Example project configuration:

```yaml
schema_version: 1
project:
  id: example-project
  name: Example Project
  mode: greenfield
  profile: standard
  language: en
framework:
  version: 1.0.0
adapter:
  primary: codex
workflow:
  id: greenfield-standard
  version: 1.0.0
approvals:
  business_scope: human_required
  requirements: human_required
  product_backlog: human_required
  ux: human_required
  architecture: human_required
  implementation_plan: human_required
  release_candidate: human_required
  production_deployment: human_required
plugins:
  enforcement: strict
  fallback_requires_human_approval: true
cache:
  provider: sqlite
  path: .agent-team/cache/index.db
security:
  classification: internal
  secret_scan: required
```

Environment files define deployment, data, observability, and approval requirements without storing secret values.

## 37. Bootstrap and Upgrade Strategy

Managed hybrid mode is preferred:

- Core engine and schemas come from packages.
- Project configuration and artifacts are project-owned.
- Codex adapter files are generated.
- Local overrides are explicit and versioned.
- Upgrades show a diff and never silently overwrite customizations.

Commands:

```bash
system-design-team init
system-design-team adopt
system-design-team status
system-design-team inspect
system-design-team doctor
system-design-team repair
system-design-team upgrade --check
system-design-team upgrade --dry-run
system-design-team eject
system-design-team uninstall
```

`adopt` inventories an existing repository without modifying source code.

Schema migrations are deterministic, idempotent, tested, and reversible where practical. They preserve history and never auto-approve new content.

Upgrade conflicts preserve local files, generate a three-way diff, write proposed merges separately, and block until resolved.

`eject` materializes managed assets and disables automatic upgrades. `uninstall` preserves `.agent-team/` by default. Full project-memory purge requires a separate destructive command and strong confirmation.

## 38. CLI Command Surface

```bash
system-design-team init
system-design-team adopt
system-design-team status
system-design-team inspect
system-design-team start <phase>
system-design-team validate <phase>
system-design-team review <phase>
system-design-team approve <gate>
system-design-team reject <gate>
system-design-team handover <phase>
system-design-team artifact list
system-design-team artifact inspect <id>
system-design-team artifact validate <id>
system-design-team trace check
system-design-team trace coverage
system-design-team stale list
system-design-team glossary validate
system-design-team evidence verify
system-design-team gate readiness <gate>
system-design-team issue list
system-design-team council start
system-design-team change create
system-design-team secrets scan
system-design-team cache rebuild
system-design-team diagnostics
system-design-team doctor
system-design-team repair
system-design-team upgrade --dry-run
```

## 39. Codex Adapter Interface

```ts
interface AgentExecutionAdapter {
  checkCapabilities(
    requirements: CapabilityRequirements,
  ): Promise<CapabilityReport>;

  prepareExecution(
    dispatch: AgentDispatch,
  ): Promise<PreparedExecution>;

  execute(
    prepared: PreparedExecution,
  ): Promise<ExecutionHandle>;

  collectResult(
    handle: ExecutionHandle,
  ): Promise<AgentExecutionResult>;

  cancel(
    handle: ExecutionHandle,
  ): Promise<void>;
}
```

```ts
interface PluginAdapter {
  resolve(uri: string): Promise<ResolvedPlugin>;
  verifySkill(plugin: ResolvedPlugin, skill: string): Promise<boolean>;
  invoke(request: PluginInvocationRequest): Promise<PluginInvocationResult>;
}
```

Core framework and adapter versions are independent and have explicit compatibility ranges.

## 40. Model Selection and Budgets

Core agent definitions request capability classes rather than hardcoding model names:

- `deep_reasoning`
- `coding`
- `fast_review`
- `document_analysis`
- `visual_design`

The adapter maps capability classes to available models.

Execution budgets include preferred and maximum context/output tokens, parallel-agent limit, and revision limit. When budgets are exceeded, the framework reduces irrelevant context or splits work by bounded responsibility. It does not skip review or approval gates.

## 41. Testing Strategy

Testing layers:

```text
Unit Tests
→ Schema and Policy Tests
→ Workflow Integration Tests
→ Adapter Contract Tests
→ END2END Scenario Tests
→ Security and Recovery Tests
```

### 41.1 Unit and State Tests

Cover transition validation, approvals, versioning, traceability, stale propagation, plugin resolution, context selection, scope matching, configuration merging, and idempotency.

Invalid transitions must not mutate state or create false audit events.

### 41.2 Schema and Semantic Tests

Each structured artifact has valid, minimum-valid, invalid-ID, missing-field, invalid-status, broken-dependency, and compatibility fixtures.

Semantic tests detect vague NFRs, untestable requirements, empty acceptance criteria, non-decisions in ADRs, unspecified expected results, and incomplete rollback/runbook instructions.

### 41.3 Policy Tests

Production deployment is rejected without G8, current QA/security verdicts, rollback, backup verification, and explicit authorization.

Architecture approval is rejected without independent review, multiple viable options or approved exemption, required security review, current technology evaluation, and responses to critical NFRs.

Self-approval is rejected in every profile.

### 41.4 Traceability and Staleness Tests

Test orphan nodes, superseded links, missing tests, stale evidence, and precise dependency propagation. A local change must not invalidate unrelated modules.

### 41.5 Plugin Contract Tests

Cover availability, missing skill, incompatible version, identity mismatch, invocation failure, malformed output, missing evidence, fallback approval, and optional plugin absence.

### 41.6 Adapter Tests

Use fake runtimes to verify manifests, context scope, permissions, plugin contracts, output validation, failure behavior, reviewer isolation, checkpoint persistence, and cancellation.

### 41.7 Filesystem and Git Tests

Cover fresh/adopted repositories, dirty trees, detached HEAD, missing Git, read-only paths, concurrent commands, changed approved artifacts, override conflicts, eject, and non-destructive uninstall.

### 41.8 SQLite Tests

Cover empty/populated builds, incremental updates, corruption, version mismatch, commit lag, deletion, and rebuild from Git.

### 41.9 Security Tests

Cover path traversal, symlink escape, prompt injection, secret leakage, command injection, plugin spoofing, and permission escalation.

### 41.10 Recovery Tests

Simulate crashes before and after atomic replacement, between artifact and registry updates, during approval, migration, and cache rebuild. Recovery must produce a fully old or fully new state, never a mixed state.

## 42. END2END Test Scenarios

### 42.1 Greenfield

Fixture: Internal Leave Request System.

Tests G0–G9, revision, handover, plugin evidence, architecture options, one vertical implementation slice, QA, release preparation, blocked production deployment before approval, and post-release acceptance.

### 42.2 Existing System

Fixture: Legacy ASP.NET Web Forms Order System.

Change: add server-side authorization to an admin function.

Required behavior:

- Analyze the existing authentication and authorization flow first.
- Create delta requirements and architecture.
- Modify existing files.
- Add server-side authorization and regression tests.
- Invoke Security Reviewer.
- Reject frontend-only hiding as authorization.
- Reject duplicate files such as `AdminPageFixedV2.aspx`.

### 42.3 Migration

Fixture: Oracle order data migration to PostgreSQL.

Required behavior:

- Inventory and mapping
- Transformation and dry run
- Reconciliation
- Data Reviewer verdict
- Cutover readiness
- Human cutover approval
- Post-migration reconciliation
- Separate decommission approval

Cutover is blocked if reconciliation, rollback, or data-loss policy is incomplete.

## 43. Adversarial Output Tests

The framework rejects:

- Unsupported “everything passed” claims.
- Placeholder security or architecture sections.
- Agent-authored plugin-use claims without adapter evidence.
- Facts without evidence classification.
- Empty or generic review reports.
- Implementation without approved scope.
- Tests disabled to achieve green status.

## 44. Performance and Compatibility Targets

Initial targets, excluding model execution:

- Initialization under 5 seconds.
- Standard state validation under 2 seconds.
- Traceability check for 5,000 links under 3 seconds.
- SQLite rebuild for 10,000 artifacts under 30 seconds.
- Cached status command under 1 second.

Test matrix:

- Windows, Linux, macOS
- Node.js 20 and 22
- LF and CRLF
- Case-sensitive and case-insensitive filesystems
- Long paths and Unicode names

## 45. CI Pipeline

```text
Install
→ Type check
→ Lint
→ Unit tests
→ Schema tests
→ Policy tests
→ Workflow integration tests
→ Security tests
→ Package build
→ Package smoke tests
→ END2END fixture tests
```

PR controls:

- No breaking schema change without migration.
- No manually modified generated file.
- No agent definition without contract tests.
- No new gate without policy tests.
- No plugin requirement without doctor diagnostics.
- No CLI command without help and error tests.

## 46. Version Roadmap

### Version 1 — Codex-First Workflow Framework

- TypeScript monorepo and CLI
- Bootstrap and adopt
- Greenfield, existing-system, and migration workflows
- Markdown/YAML project store
- Approval and review engine
- Artifact, traceability, and stale engine
- Agent catalogue and contracts
- Codex adapter
- Plugin registry and evidence
- Optional SQLite cache
- END2END fixtures

### Version 2 — Enhanced Codex Orchestration

- Parallel bounded subagent dispatch
- Automated handover bundles
- Council orchestration
- GitHub issue and PR integration
- CI artifact validation
- Progress dashboard
- Project health analytics

### Version 3 — Optional Python Multi-Agent Runtime

- Persistent sessions
- Event/message bus
- Execution queue
- Central observability
- Cost controls
- Multi-project workspace
- Human approval interface
- Codex remains an execution adapter

## 47. Version 1 Implementation Milestones

1. **Core Domain and Repository Layout** — types, schemas, manifests, config loader, project store.
2. **Workflow Engine** — states, gates, reviews, approvals, changes, audit, atomic persistence.
3. **Artifact and Traceability Engine** — registry, validation, graph, coverage, stale propagation.
4. **CLI and Project Management** — init, adopt, status, doctor, validate, approve, handover, upgrade dry run, cache.
5. **Codex and Plugin Adapters** — dispatch, context, permissions, capability checks, invocation evidence.
6. **Agent Catalogue and Templates** — all roles, contracts, checklists, core artifacts, three workflows.
7. **END2END Validation** — greenfield, existing-system, migration, security, recovery, cross-platform.
8. **Beta Release** — packages, installation, tutorials, examples, upgrades, security model, troubleshooting.

Recommended order:

```text
Domain contracts
→ Workflow state machine
→ Artifact validation
→ Approval enforcement
→ Project storage
→ CLI
→ Adapter interface
→ First vertical agent flow
→ Full agent catalogue
→ END2END workflows
```

First vertical slice:

```text
Project Intake
→ Business Analyst
→ Requirements Reviewer
→ Requirements Approval
→ Product Owner Handover
```

This slice proves plugin checks, dispatch, artifact generation, validation, review, revision, approval, handover, audit, and traceability before expanding to all roles.

## 48. Version 1 Definition of Done

Version 1 is complete only when:

1. The central repository and packages build reproducibly.
2. New and existing repositories can be initialized without manual core edits.
3. Greenfield, existing-system, and migration modes operate.
4. All core roles have manifests and contracts.
5. Required plugins are mapped and checked per role.
6. A missing required plugin blocks the phase in strict mode.
7. Agents cannot skip approval gates or self-approve.
8. Artifacts have version, dependencies, owner, reviewer, and traceability.
9. Changed approved inputs invalidate affected downstream state correctly.
10. Developers cannot modify code before G6.
11. QA cannot pass work without current execution evidence.
12. DevOps cannot deploy production before G8 and explicit authorization.
13. Destructive actions require explicit human approval.
14. Git files remain authoritative.
15. SQLite can be deleted and rebuilt.
16. Audit history explains actions and authorization.
17. Interrupted state updates recover safely.
18. Three END2END fixture projects pass.
19. Installation, operation, upgrade, recovery, and troubleshooting documentation exists.
20. No prohibited placeholders or contradictory policies remain.

## 49. Product Success Criteria

The product is successful when:

- A user can bootstrap it without understanding core internals.
- The team can move from business intent to a release-ready system package.
- Critical phases cannot be skipped silently.
- Implementation changes trace to approved requirements.
- Critical requirements have current verification evidence.
- The project owner retains control of scope, stack, destructive changes, and production.
- Existing systems are improved without an unapproved rewrite.
- Missing plugins, stale artifacts, hidden blockers, and unsupported claims are detected before downstream damage.
- Human teams can inspect, audit, continue, and override the agent workflow safely.

## 50. Design Decisions

| Decision | Outcome |
|---|---|
| Primary runtime | Codex-first |
| Architecture | Hybrid, CLI-driven in V1 |
| Automation | END2END with approval gates |
| Project modes | Greenfield, existing system, migration |
| Distribution | Central framework plus project bootstrap |
| Orchestration | Hierarchical pipeline with exceptional council |
| Language | English-only artifacts and agent communication |
| Technology selection | Agent proposes options; human approves |
| Cross-functional roles | Security, data/database, documentation, operations |
| Bootstrap runtime | TypeScript CLI |
| Future runtime | Optional Python orchestration service |
| State source of truth | Markdown/YAML in Git |
| Cache | Optional rebuildable SQLite |
| Plugin enforcement | Required per role with verifiable evidence |
| Author/reviewer | Independent, no self-approval |
| Production deployment | Explicit human authorization required |

## 51. Resolved Consistency Notes

- The standard profile defaults all major gates to human approval; the safety minimum always requires human approval for scope, requirements, UX direction, stack, destructive migration, production deployment, and business acceptance.
- Security review uses available security capability plus `systems-architecture` for security architecture. Strict workflows block when a mandatory capability cannot be verified.
- `.codex/` is an adapter-owned generated surface, not a guarantee about permanent Codex internals.
- Version 1 enforces deployment policy and can dispatch authorized deployment work, but production connectors remain environment-specific and are never assumed.
- Agent Council is bounded and exceptional, preventing token-heavy discussion from becoming the default workflow.
- Optional SQLite improves search and reporting but never owns unique project state.

## 52. Approval Status

All eight design sections were reviewed and approved by the project owner during the design discussion:

1. Overall Architecture
2. Agent Roles and Handover Contracts
3. Workflow Engine, States, Approval Gates, and Review Loops
4. Artifact System, Traceability, Project Memory, and Validation
5. Codex Adapter, Plugin Integration, Agent Dispatch, and Execution Safety
6. Bootstrap CLI, Project Profiles, Configuration, and Upgrade Strategy
7. Security, Governance, Reliability, and Operational Controls
8. Testing Strategy, Implementation Roadmap, and Definition of Success

The next workflow stage is implementation planning. Implementation must not begin until the written specification is reviewed and explicitly approved as the authoritative design baseline.

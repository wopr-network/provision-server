/**
 * Core types for the provision-server protocol.
 *
 * Every OSS project that wants to be provisionable by wopr fleet
 * implements ProvisionAdapter to map these generic operations to
 * its own domain model.
 */

/** Admin user to be pre-created for login access. */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
}

/** Agent/worker spec provided during provisioning. */
export interface AgentSpec {
  name: string;
  role: string;
  title?: string;
  reportsTo?: string;
  budgetMonthlyCents?: number;
}

/** Created agent returned after provisioning. */
export interface CreatedAgent {
  id: string;
  name: string;
  role: string;
}

/** Full provisioning request from the platform. */
export interface ProvisionRequest {
  tenantId: string;
  tenantName: string;
  gatewayUrl: string;
  apiKey: string;
  budgetCents: number;
  adminUser: AdminUser;
  agents?: AgentSpec[];
  /** Escape hatch: project-specific fields go here. */
  extra?: Record<string, unknown>;
}

/** Response from a successful provision. */
export interface ProvisionResponse {
  /** Project-internal tenant/org/company ID. */
  tenantEntityId: string;
  /** Human-readable identifier (issue prefix, slug, etc.) */
  tenantSlug?: string;
  adminUserId: string;
  agents: CreatedAgent[];
  /** Escape hatch: project-specific response fields. */
  extra?: Record<string, unknown>;
}

/**
 * The adapter interface. Each OSS project implements this to
 * map provisioning operations to its own domain model.
 *
 * Paperclip maps tenants → companies, agents → agents.
 * The next project maps tenants → workspaces, agents → bots.
 * Whatever.
 */
export interface ProvisionAdapter {
  /**
   * Create the tenant entity (company, workspace, org — whatever the project calls it).
   * Returns an opaque ID that the platform stores for future calls (budget, teardown).
   */
  createTenant(req: ProvisionRequest): Promise<{ id: string; slug?: string }>;

  /**
   * Ensure the admin user exists in the auth system.
   * Idempotent — skip if user already exists (re-provisioning case).
   */
  ensureUser(user: AdminUser): Promise<void>;

  /**
   * Grant the admin user access to the tenant entity.
   * Role semantics are project-specific (owner, admin, etc.)
   */
  grantAccess(tenantEntityId: string, userId: string): Promise<void>;

  /**
   * Seed agents/workers/bots with gateway config.
   * Optional — not all projects have an "agents" concept.
   * The adapter receives the raw agent specs and the gateway config,
   * and is responsible for creating them in whatever shape the project needs.
   */
  seedAgents?(
    tenantEntityId: string,
    agents: AgentSpec[],
    gateway: { url: string; apiKey: string },
  ): Promise<CreatedAgent[]>;

  /**
   * Update the tenant's spending budget.
   * Called by platform-core when credits change.
   */
  updateBudget(tenantEntityId: string, budgetCents: number): Promise<void>;

  /**
   * Update per-agent budgets.
   * Optional — only relevant for projects with agent budgets.
   */
  updateAgentBudgets?(tenantEntityId: string, perAgentCents: number): Promise<void>;

  /**
   * Check whether a tenant entity exists.
   * Used by budget and teardown endpoints.
   */
  tenantExists(tenantEntityId: string): Promise<boolean>;

  /**
   * Tear down the tenant entity and all associated data.
   * Called when a customer cancels.
   */
  teardown(tenantEntityId: string): Promise<void>;

  /**
   * Optional hook called after successful provisioning.
   * Use for audit logging, webhooks, etc.
   */
  onProvisioned?(req: ProvisionRequest, result: ProvisionResponse): Promise<void>;
}

/** Options for creating the provision router. */
export interface ProvisionRouterOptions {
  /**
   * Env var name that holds the bearer token secret.
   * Defaults to "WOPR_PROVISION_SECRET".
   */
  secretEnvVar?: string;

  /**
   * Env var name used to indicate "managed" mode in health check.
   * Defaults to "WOPR_GATEWAY_URL".
   */
  managedEnvVar?: string;
}

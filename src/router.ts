import { Router } from "express";
import type { ProvisionAdapter, ProvisionRouterOptions } from "./types.js";

/**
 * Create an Express router that exposes the provisioning protocol.
 *
 * Mount it at `/internal` in your app:
 *
 *   app.use("/internal", createProvisionRouter(myAdapter));
 *
 * Endpoints:
 *   POST   /provision        — provision a new tenant
 *   PUT    /provision/budget  — update budget
 *   DELETE /provision         — teardown
 *   GET    /provision/health  — health check (no auth)
 */
export function createProvisionRouter(adapter: ProvisionAdapter, opts?: ProvisionRouterOptions): Router {
  const secretVar = opts?.secretEnvVar ?? "WOPR_PROVISION_SECRET";
  const managedVar = opts?.managedEnvVar ?? "WOPR_GATEWAY_URL";

  const router = Router();

  /** Validate bearer token against env var. */
  function assertAuth(authHeader: string | undefined): void {
    const secret = process.env[secretVar];
    if (!secret) {
      const err = new Error(`${secretVar} not set — provisioning API disabled`);
      throw err;
    }
    if (!authHeader?.startsWith("Bearer ")) {
      const err = Object.assign(new Error("Missing provision bearer token"), { status: 401 });
      throw err;
    }
    const token = authHeader.slice("Bearer ".length).trim();
    if (token !== secret) {
      const err = Object.assign(new Error("Invalid provision token"), { status: 401 });
      throw err;
    }
  }

  /** Throw a 422 with a message. */
  function unprocessable(msg: string): never {
    throw Object.assign(new Error(msg), { status: 422 });
  }

  // ─── POST /provision ────────────────────────────────────────────────
  router.post("/provision", async (req, res) => {
    assertAuth(req.header("authorization"));

    const body = req.body;
    if (!body.tenantId || !body.tenantName || !body.gatewayUrl) {
      unprocessable("Missing required fields: tenantId, tenantName, gatewayUrl");
    }
    if (!body.adminUser?.id || !body.adminUser?.email) {
      unprocessable("Missing required fields: adminUser.id, adminUser.email");
    }

    const provisionReq = {
      tenantId: body.tenantId as string,
      tenantName: body.tenantName as string,
      gatewayUrl: body.gatewayUrl as string,
      apiKey: (body.apiKey as string) ?? "",
      budgetCents: (body.budgetCents as number) ?? 0,
      adminUser: {
        id: body.adminUser.id as string,
        email: body.adminUser.email as string,
        name: (body.adminUser.name as string) ?? body.adminUser.email,
      },
      agents: body.agents as
        | Array<{ name: string; role: string; title?: string; reportsTo?: string; budgetMonthlyCents?: number }>
        | undefined,
      extra: body.extra as Record<string, unknown> | undefined,
    };

    // 1. Create tenant entity
    const tenant = await adapter.createTenant(provisionReq);

    // 2. Ensure admin user exists
    await adapter.ensureUser(provisionReq.adminUser);

    // 3. Grant access
    await adapter.grantAccess(tenant.id, provisionReq.adminUser.id);

    // 4. Seed agents if provided and adapter supports it
    let createdAgents: Array<{ id: string; name: string; role: string }> = [];
    if (Array.isArray(provisionReq.agents) && provisionReq.agents.length > 0 && adapter.seedAgents) {
      createdAgents = await adapter.seedAgents(tenant.id, provisionReq.agents, {
        url: provisionReq.gatewayUrl,
        apiKey: provisionReq.apiKey,
      });
    }

    const result = {
      tenantEntityId: tenant.id,
      tenantSlug: tenant.slug,
      adminUserId: provisionReq.adminUser.id,
      agents: createdAgents,
    };

    // 5. Post-provision hook
    if (adapter.onProvisioned) {
      await adapter.onProvisioned(provisionReq, result);
    }

    res.status(201).json(result);
  });

  // ─── PUT /provision/budget ──────────────────────────────────────────
  router.put("/provision/budget", async (req, res) => {
    assertAuth(req.header("authorization"));

    const { tenantEntityId, budgetCents, perAgentCents } = req.body;
    if (!tenantEntityId || budgetCents === undefined) {
      unprocessable("Missing required fields: tenantEntityId, budgetCents");
    }

    const exists = await adapter.tenantExists(tenantEntityId);
    if (!exists) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    await adapter.updateBudget(tenantEntityId, budgetCents);

    if (perAgentCents !== undefined && adapter.updateAgentBudgets) {
      await adapter.updateAgentBudgets(tenantEntityId, perAgentCents);
    }

    res.json({ ok: true, tenantEntityId, budgetCents });
  });

  // ─── DELETE /provision ──────────────────────────────────────────────
  router.delete("/provision", async (req, res) => {
    assertAuth(req.header("authorization"));

    const { tenantEntityId } = req.body;
    if (!tenantEntityId) {
      unprocessable("Missing required field: tenantEntityId");
    }

    const exists = await adapter.tenantExists(tenantEntityId);
    if (!exists) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    await adapter.teardown(tenantEntityId);
    res.json({ ok: true, tenantEntityId });
  });

  // ─── GET /provision/health ──────────────────────────────────────────
  router.get("/provision/health", (_req, res) => {
    const secret = process.env[secretVar];
    res.json({
      ok: true,
      provisioning: Boolean(secret),
      managed: Boolean(process.env[managedVar]),
    });
  });

  return router;
}

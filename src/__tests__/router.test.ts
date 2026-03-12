import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProvisionRouter } from "../router.js";
import type { ProvisionAdapter } from "../types.js";

const SECRET = "test-provision-secret";

function mockAdapter(): ProvisionAdapter {
  return {
    createTenant: vi.fn().mockResolvedValue({ id: "tenant-1", slug: "ACM" }),
    ensureUser: vi.fn().mockResolvedValue(undefined),
    grantAccess: vi.fn().mockResolvedValue(undefined),
    seedAgents: vi.fn().mockResolvedValue([{ id: "a1", name: "CEO", role: "ceo" }]),
    updateBudget: vi.fn().mockResolvedValue(undefined),
    updateAgentBudgets: vi.fn().mockResolvedValue(undefined),
    tenantExists: vi.fn().mockResolvedValue(true),
    teardown: vi.fn().mockResolvedValue(undefined),
    onProvisioned: vi.fn().mockResolvedValue(undefined),
  };
}

function createApp(adapter: ProvisionAdapter) {
  vi.stubEnv("WOPR_PROVISION_SECRET", SECRET);
  const app = express();
  app.use(express.json());
  app.use("/internal", createProvisionRouter(adapter));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("provision-server router", () => {
  let adapter: ReturnType<typeof mockAdapter>;
  let app: express.Express;

  beforeEach(() => {
    vi.resetAllMocks();
    adapter = mockAdapter();
    app = createApp(adapter);
  });

  describe("auth", () => {
    it("rejects requests without auth header", async () => {
      const res = await request(app).post("/internal/provision").send({ tenantId: "t1" });
      expect(res.status).toBe(401);
    });

    it("rejects wrong token", async () => {
      const res = await request(app)
        .post("/internal/provision")
        .set("Authorization", "Bearer wrong")
        .send({ tenantId: "t1" });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /provision", () => {
    const validBody = {
      tenantId: "t-abc",
      tenantName: "Acme Corp",
      gatewayUrl: "https://gw.test/v1",
      apiKey: "sk-xyz",
      budgetCents: 10000,
      adminUser: { id: "user-1", email: "a@acme.com", name: "Admin" },
      agents: [{ name: "CEO", role: "ceo" }],
    };

    it("rejects missing required fields", async () => {
      const res = await request(app)
        .post("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantId: "t1" });
      expect(res.status).toBe(422);
    });

    it("calls adapter in order and returns result", async () => {
      const res = await request(app)
        .post("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.tenantEntityId).toBe("tenant-1");
      expect(res.body.tenantSlug).toBe("ACM");
      expect(res.body.adminUserId).toBe("user-1");
      expect(res.body.agents).toHaveLength(1);

      // Verify call order
      expect(adapter.createTenant).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "t-abc", tenantName: "Acme Corp" }),
      );
      expect(adapter.ensureUser).toHaveBeenCalledWith(expect.objectContaining({ id: "user-1", email: "a@acme.com" }));
      expect(adapter.grantAccess).toHaveBeenCalledWith("tenant-1", "user-1");
      expect(adapter.seedAgents).toHaveBeenCalledWith("tenant-1", [{ name: "CEO", role: "ceo" }], {
        url: "https://gw.test/v1",
        apiKey: "sk-xyz",
      });
      expect(adapter.onProvisioned).toHaveBeenCalled();
    });

    it("works without agents when adapter has no seedAgents", async () => {
      const adapterNoAgents = mockAdapter();
      delete (adapterNoAgents as any).seedAgents;
      const noAgentApp = createApp(adapterNoAgents);

      const res = await request(noAgentApp)
        .post("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.agents).toEqual([]);
    });
  });

  describe("PUT /provision/budget", () => {
    it("updates budget via adapter", async () => {
      const res = await request(app)
        .put("/internal/provision/budget")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "tenant-1", budgetCents: 50000 });

      expect(res.status).toBe(200);
      expect(adapter.updateBudget).toHaveBeenCalledWith("tenant-1", 50000);
    });

    it("updates per-agent budgets when specified", async () => {
      const res = await request(app)
        .put("/internal/provision/budget")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "tenant-1", budgetCents: 50000, perAgentCents: 10000 });

      expect(res.status).toBe(200);
      expect(adapter.updateAgentBudgets).toHaveBeenCalledWith("tenant-1", 10000);
    });

    it("returns 404 for unknown tenant", async () => {
      (adapter.tenantExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = await request(app)
        .put("/internal/provision/budget")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "nope", budgetCents: 100 });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /provision", () => {
    it("tears down via adapter", async () => {
      const res = await request(app)
        .delete("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "tenant-1" });

      expect(res.status).toBe(200);
      expect(adapter.teardown).toHaveBeenCalledWith("tenant-1");
    });

    it("returns 404 for unknown tenant", async () => {
      (adapter.tenantExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = await request(app)
        .delete("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "nope" });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /provision/health", () => {
    it("returns health without auth", async () => {
      const res = await request(app).get("/internal/provision/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.provisioning).toBe(true);
    });
  });
});

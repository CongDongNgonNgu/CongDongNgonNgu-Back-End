import { compileCoarseRequestPlan } from "./coarse-request-plan";
import type {
  RequestCatalogue,
  RequestCatalogueGroup,
} from "./request-catalogue";
import type { ActivationEnvelope } from "./guard";
const envelope = {
  budgets: {
    authenticatedRequests: 120,
    anonymousRequests: 20,
    ingressBytes: 33554432,
    authenticatedEgressBytes: 67108864,
    anonymousEgressBytes: 16777216,
  },
} as ActivationEnvelope;
const path = "/api/v1/attachments/11111111-1111-4111-8111-111111111111/content";
const group = (key = "policy", count = 2): RequestCatalogueGroup => ({
  method: "GET",
  path,
  authClass: "AUTH",
  ingressBytes: 0,
  egressBytes: 100,
  attemptCount: count,
  policies: [
    {
      operationKey: key,
      attemptKeys: Array.from(
        { length: count },
        (_, i) => key + "-attempt-" + i,
      ),
    },
  ],
});
const catalogue = (groups: RequestCatalogueGroup[]): RequestCatalogue => ({
  groups,
  totals: {
    authenticatedRequests: 0,
    anonymousRequests: 0,
    ingressBytes: 0,
    authenticatedEgressBytes: 0,
    anonymousEgressBytes: 0,
  },
});
describe("coarse request inventory compilation only", () => {
  it("generates detached coarse keys and conservative candidate charges, never policy attempt names", () => {
    const g = group(),
      p = compileCoarseRequestPlan(catalogue([g]), envelope);
    expect(p.requests.candidates).toEqual([
      {
        key: "coarse-c000",
        method: "GET",
        path,
        authClass: "AUTH",
        ingressBytes: 0,
        egressBytes: 100,
      },
    ]);
    expect(p.requests.attempts).toEqual([
      { key: "coarse-r000", candidateKey: "coarse-c000" },
      { key: "coarse-r001", candidateKey: "coarse-c000" },
    ]);
    expect(p.candidates[0]).toMatchObject({
      candidateKey: "coarse-c000",
      policyKeys: ["policy"],
      attemptCount: 2,
    });
    expect(JSON.stringify(p.requests)).not.toContain("policy-attempt");
    (g.policies[0].attemptKeys as string[])[0] = "changed";
    expect(p.requests.attempts[0].key).toBe("coarse-r000");
  });
  it("sorts groups and policy provenance deterministically before allocating keys", () => {
    const a = { ...group("a", 1), method: "HEAD" as const },
      b = group("b", 1),
      c = { ...group("c", 1), authClass: "ANON" as const };
    expect(compileCoarseRequestPlan(catalogue([a, b, c]), envelope)).toEqual(
      compileCoarseRequestPlan(catalogue([c, a, b]), envelope),
    );
  });
  it("recomputes grouped byte totals rather than trusting catalogue totals", () => {
    const e = {
      ...envelope,
      budgets: { ...envelope.budgets, authenticatedEgressBytes: 199 },
    };
    expect(() => compileCoarseRequestPlan(catalogue([group()]), e)).toThrow(
      /^TEST_ADMISSION_COARSE_PLAN$/,
    );
    expect(
      compileCoarseRequestPlan(catalogue([group()]), {
        ...e,
        budgets: { ...e.budgets, authenticatedEgressBytes: 200 },
      }).requests.attempts,
    ).toHaveLength(2);
  });
  it("enforces independent auth/anonymous and total140 attempt ceilings", () => {
    const auth = group("auth", 120),
      anon = { ...group("anon", 20), authClass: "ANON" as const };
    expect(
      compileCoarseRequestPlan(catalogue([auth, anon]), envelope).requests
        .attempts,
    ).toHaveLength(140);
    for (const groups of [
      [group("auth", 121)],
      [
        {
          ...anon,
          attemptCount: 21,
          policies: [
            {
              operationKey: "anon",
              attemptKeys: Array.from({ length: 21 }, (_, i) => "a" + i),
            },
          ],
        },
      ],
    ])
      expect(() =>
        compileCoarseRequestPlan(catalogue(groups), envelope),
      ).toThrow("TEST_ADMISSION_COARSE_PLAN");
  });
  it("rejects duplicate routes, nonliteral routes, count mismatches and unsafe counters", () => {
    for (const groups of [
      [group(), group("other")],
      [{ ...group(), path: path + "?x=1" }],
      [{ ...group(), attemptCount: 1 }],
      [{ ...group(), egressBytes: NaN }],
      [{ ...group(), authClass: "ANON" as const, ingressBytes: 1 }],
    ])
      expect(() =>
        compileCoarseRequestPlan(catalogue(groups), envelope),
      ).toThrow(/^TEST_ADMISSION_COARSE_PLAN$/);
  });
  it("does not generate bindings, allocation slots or activation authority", () => {
    const p = compileCoarseRequestPlan(catalogue([group()]), envelope);
    expect(Object.keys(p).sort()).toEqual(["candidates", "requests"]);
    expect(Object.keys(p.requests).sort()).toEqual(["attempts", "candidates"]);
  });
});

// Unit tests for config.mjs — loadConfig factory.
// Tests ONLY pure logic: required-field validation and sane-default application.
// No network, no RPC, no child_process mocking required.
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.mjs";

describe("loadConfig — required field validation", () => {
  it("throws when env is empty (names WORKDIR)", () => {
    expect(() => loadConfig({})).toThrow(/WORKDIR/);
  });

  it("throws when WORKDIR is empty string (names WORKDIR)", () => {
    expect(() =>
      loadConfig({ WORKDIR: "", COURT_ID: "34", KLEROS_JUROR_HOME: "/h" })
    ).toThrow(/WORKDIR/);
  });

  it("throws when COURT_ID is missing", () => {
    expect(() =>
      loadConfig({ WORKDIR: "/x", KLEROS_JUROR_HOME: "/h" })
    ).toThrow(/COURT_ID/);
  });

  it("throws when KLEROS_JUROR_HOME is missing", () => {
    expect(() =>
      loadConfig({ WORKDIR: "/x", COURT_ID: "34" })
    ).toThrow(/KLEROS_JUROR_HOME/);
  });
});

describe("loadConfig — sane defaults", () => {
  const MINIMAL = { WORKDIR: "/x", COURT_ID: "34", KLEROS_JUROR_HOME: "/h" };

  it("returns EVIDENCE_CHAIN as 'arbitrum-one' by default", () => {
    const cfg = loadConfig(MINIMAL);
    expect(cfg.EVIDENCE_CHAIN).toBe("arbitrum-one");
  });

  it("allows EVIDENCE_CHAIN override via env", () => {
    const cfg = loadConfig({ ...MINIMAL, EVIDENCE_CHAIN: "custom-chain" });
    expect(cfg.EVIDENCE_CHAIN).toBe("custom-chain");
  });

  it("exports WORKDIR, COURT_ID, KLEROS_JUROR_HOME from required fields", () => {
    const cfg = loadConfig(MINIMAL);
    expect(cfg.WORKDIR).toBe("/x");
    expect(cfg.COURT_ID).toBe("34");
    expect(cfg.KLEROS_JUROR_HOME).toBe("/h");
  });

  it("applies RPC_URLS default (non-empty array)", () => {
    const cfg = loadConfig(MINIMAL);
    expect(Array.isArray(cfg.RPC_URLS)).toBe(true);
    expect(cfg.RPC_URLS.length).toBeGreaterThan(0);
  });

  it("allows RPC_URLS override via JSON env string", () => {
    const urls = '["https://my-rpc.example.com"]';
    const cfg = loadConfig({ ...MINIMAL, RPC_URLS: urls });
    expect(cfg.RPC_URLS).toEqual(["https://my-rpc.example.com"]);
  });
});

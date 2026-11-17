import { describe, expect, it } from "vitest";
import { cleanPath, isDeniedKey, sanitizeProps } from "../src/shared/privacy";

describe("privacy", () => {
  it("drops denied keys", () => {
    expect(sanitizeProps({ plan: "pro", user_email: "a@b.co", totalAmount: 10, revenue: 5, tooltip: "x", zip: "1" })).toEqual({
      plan: "pro",
      tooltip: "x",
      zip: "1",
    });
    expect(isDeniedKey("client_ip")).toBe(true);
    expect(isDeniedKey("ip")).toBe(true);
  });
  it("drops email-looking values, objects and caps strings", () => {
    const out = sanitizeProps({ note: "write to me@x.com", nested: { a: 1 }, long: "x".repeat(500) });
    expect(out).toEqual({ long: "x".repeat(200) });
  });
  it("returns null when nothing is left", () => {
    expect(sanitizeProps({ password: "x" })).toBeNull();
    expect(sanitizeProps("nope")).toBeNull();
  });
  it("strips query strings and hashes from paths", () => {
    expect(cleanPath("/reset?token=abc#x")).toBe("/reset");
    expect(cleanPath("https://example.com/a/b?c=1")).toBe("/a/b");
  });
});

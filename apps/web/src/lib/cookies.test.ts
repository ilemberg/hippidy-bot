import { describe, expect, it } from "vitest";
import { deleteCookie, readCookie, serializeCookie } from "./cookies.ts";

describe("cookies", () => {
  it("writes HttpOnly, Secure, SameSite=Lax cookies", () => {
    expect(serializeCookie("a", "x.y-z_1", { path: "/", maxAge: 60 })).toBe(
      "a=x.y-z_1; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax",
    );
    expect(deleteCookie("a", "/p")).toBe("a=; Path=/p; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  });

  it("refuses a value that could add attributes", () => {
    expect(() => serializeCookie("a", "x; Domain=evil", { path: "/", maxAge: 1 })).toThrow();
  });

  it("reads one cookie from a header", () => {
    const header = "other=1; hippidy_session=abc.def; x=";
    expect(readCookie(header, "hippidy_session")).toBe("abc.def");
    expect(readCookie(header, "x")).toBe("");
    expect(readCookie(header, "missing")).toBeUndefined();
    expect(readCookie(null, "x")).toBeUndefined();
  });
});

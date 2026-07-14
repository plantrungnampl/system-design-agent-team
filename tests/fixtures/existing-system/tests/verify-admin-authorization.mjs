import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const hasServerAuthorization = (source) => {
  const authorization = source.indexOf('Authorization.RequireRole("Administrator")');
  const deletion = source.indexOf("OrderService.Delete(orderId)");
  return authorization >= 0 && deletion > authorization;
};

test("the existing delete handler enforces administrator authorization", async () => {
  const source = await readFile(new URL("../src/AdminPage.aspx.cs", import.meta.url), "utf8");
  assert.equal(hasServerAuthorization(source), true, "server-side administrator guard is missing");
});

test("hiding the delete button is not server-side authorization", () => {
  assert.equal(hasServerAuthorization('<button style="display:none">Delete</button>'), false);
});

test("the existing page is modified without Fixed or V2 copies", async () => {
  const files = await readdir(new URL("../src/", import.meta.url));
  assert.equal(files.some((name) => /(?:Fixed|V2)/i.test(name)), false);
});

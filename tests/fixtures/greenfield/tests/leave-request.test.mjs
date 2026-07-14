import assert from "node:assert/strict";
import test from "node:test";
import { LeaveRequests } from "../src/leave-request.mjs";

test("a manager can approve a submitted leave request", () => {
  const requests = new LeaveRequests();
  requests.submit("LR-1", "employee-1");

  assert.deepEqual(requests.decide("LR-1", "manager", "manager-1", "approved"), {
    id: "LR-1",
    employee: "employee-1",
    status: "approved",
    reviewer: "manager-1",
  });
});

test("a non-manager cannot decide a leave request", () => {
  const requests = new LeaveRequests();
  requests.submit("LR-2", "employee-2");

  assert.throws(
    () => requests.decide("LR-2", "employee", "employee-2", "approved"),
    /FORBIDDEN/,
  );
});

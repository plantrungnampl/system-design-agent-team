export class LeaveRequests {
  #requests = new Map();

  submit(id, employee) {
    if (this.#requests.has(id)) throw new Error("DUPLICATE_REQUEST");
    const request = { id, employee, status: "pending", reviewer: null };
    this.#requests.set(id, request);
    return { ...request };
  }

  decide(id, role, reviewer, decision) {
    if (role !== "manager") throw new Error("FORBIDDEN");
    if (!["approved", "rejected"].includes(decision)) throw new Error("INVALID_DECISION");
    const request = this.#requests.get(id);
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    Object.assign(request, { status: decision, reviewer });
    return { ...request };
  }
}

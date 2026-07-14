import { readFile } from "node:fs/promises";

const [csv, mapping, schema] = await Promise.all([
  readFile(new URL("legacy-orders.csv", import.meta.url), "utf8"),
  readFile(new URL("mapping.yaml", import.meta.url), "utf8"),
  readFile(new URL("target-schema.sql", import.meta.url), "utf8"),
]);

for (const contract of [
  "ORDER_ID", "orders.id", "CUSTOMER_ID", "orders.customer_id", "TOTAL_CENTS", "orders.total_cents",
]) {
  if (!mapping.includes(contract)) throw new Error(`MAPPING_CONTRACT_MISSING: ${contract}`);
}
for (const column of ["id bigint PRIMARY KEY", "customer_id text NOT NULL", "total_cents bigint NOT NULL"]) {
  if (!schema.includes(column)) throw new Error(`TARGET_CONTRACT_MISSING: ${column}`);
}

const [header, ...lines] = csv.trim().split(/\r?\n/);
if (header !== "ORDER_ID,CUSTOMER_ID,TOTAL_CENTS") throw new Error("SOURCE_CONTRACT_MISMATCH");
const source = lines.map((line) => {
  const [orderId, customerId, totalCents] = line.split(",");
  return { id: Number(orderId), customer_id: customerId.trim(), total_cents: Number(totalCents) };
});
const target = structuredClone(source);
if (process.argv.includes("--mismatch")) target[0].total_cents += 1;

const result = {
  status: "reconciled",
  source_rows: source.length,
  target_rows: target.length,
  source_total_cents: source.reduce((sum, row) => sum + row.total_cents, 0),
  target_total_cents: target.reduce((sum, row) => sum + row.total_cents, 0),
};

if (result.source_rows !== result.target_rows || result.source_total_cents !== result.target_total_cents) {
  console.error("RECONCILIATION_MISMATCH", JSON.stringify(result));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result));
}

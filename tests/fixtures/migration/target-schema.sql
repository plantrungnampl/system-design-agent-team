CREATE TABLE orders (
  id bigint PRIMARY KEY,
  customer_id text NOT NULL,
  total_cents bigint NOT NULL
);

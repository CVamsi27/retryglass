CREATE TABLE operations (
  operation_key text PRIMARY KEY,
  total_cents integer NOT NULL CHECK (total_cents > 0)
);
CREATE TABLE invoices (
  operation_key text PRIMARY KEY REFERENCES operations(operation_key),
  status text NOT NULL CHECK (status IN ('created', 'complete'))
);

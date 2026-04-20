import { customType } from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => v,
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array)),
});

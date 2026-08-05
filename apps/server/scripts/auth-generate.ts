import { parseArgs } from "node:util";

import { generateToken, hashToken } from "../src/auth";
import { loadConfig } from "../src/config";
import { StateStore } from "../src/state/store";

const { values } = parseArgs({ options: { rotate: { type: "boolean", default: false } } });
const config = loadConfig();
const store = new StateStore(config.statePath, { databasePath: config.databasePath });
await store.load();
const current = store.snapshot().auth.tokenSha256;
if (current && !values.rotate) {
  throw new Error("A token already exists. Pass --rotate to revoke it and generate a new token.");
}
const token = generateToken();
await store.update((state) => {
  state.auth.tokenSha256 = hashToken(token);
});
await store.checkpoint();
process.stdout.write(`${token}\n`);

import { q } from "./db";

export default async function setup() {
  await q(`TRUNCATE "user","session","account","verification","workspace","audit_log","ai_insight","notification" RESTART IDENTITY CASCADE`);
}

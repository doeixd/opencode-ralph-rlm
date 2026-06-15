import { existsSync } from "node:fs";

if (existsSync(".ralph-pass-marker")) {
  console.log("PASS");
  process.exit(0);
}

console.error("FAIL: .ralph-pass-marker missing");
process.exit(1);